import { config } from 'dotenv';
import { join } from 'path';
import yauzl from 'yauzl';

// load env 
try {
  const rootDir = join(process.cwd(), '..', '..');
  const envPath = join(rootDir, '.env');
  config({ path: envPath });
} catch (error) {
  config();
}

//schemas
export interface ProcessedImage {
  id: string;
  name: string;
  type: string;
  data: string; // base64
  pageNumber?: number;
}

export interface PDFConversionResult {
  markdown: string;
  images: ProcessedImage[];
  metadata?: {
    pageCount: number;
    title?: string;
    processingTime: number;
  };
}

export interface MineruUploadResponse {
  code: number;
  msg: string;
  trace_id: string;
  data: {
    batch_id: string;
    file_urls: string[];
  };
}

export interface MineraBatchResultResponse {
  code: number;
  msg: string;
  trace_id: string;
  data: {
    batch_id: string;
    extract_result: Array<{
      file_name: string;
      state: 'waiting-file' | 'pending' | 'running' | 'done' | 'failed' | 'converting';
      full_zip_url?: string;
      err_msg?: string;
      data_id?: string;
      extract_progress?: {
        extracted_pages: number;
        total_pages: number;
        start_time: string;
      };
    }>;
  };
}

export class MineruService {
  private apiUrl: string;
  private apiToken: string;
  private enabled: boolean;

  constructor() {
    this.apiUrl = process.env.MINERU_API_URL || '';
    this.apiToken = process.env.MINERU_API_TOKEN || '';
    this.enabled = process.env.MINERU_ENABLED === 'true';
  }

  /**
   * check if Mineru service is enabled and configured
   */
  isEnabled(): boolean {
    return this.enabled && !!this.apiUrl && !!this.apiToken;
  }

  /**
   * request an upload URL for a PDF file
   */
  async requestUploadUrl(fileName: string): Promise<{ batchId: string; uploadUrl: string }> {
    if (!this.isEnabled()) {
      throw new Error('Mineru service is not enabled or not configured properly');
    }

    const response = await fetch(`${this.apiUrl}/file-urls/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({
        enable_formula: true,
        enable_table: true,
        language: 'auto',
        files: [
          {
            name: fileName,
            is_ocr: true,
            data_id: `pdf_${Date.now()}`,
          }
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Mineru upload URL request failed: ${response.status} ${response.statusText}`);
    }

    const result: MineruUploadResponse = await response.json();
    
    if (result.code !== 0) {
      throw new Error(`Mineru upload URL request failed: ${result.msg}`);
    }

    if (!result.data.file_urls || result.data.file_urls.length === 0) {
      throw new Error('No upload URL returned from Mineru');
    }

    return {
      batchId: result.data.batch_id,
      uploadUrl: result.data.file_urls[0],
    };
  }

  /**
   * Upload file to Mineru
   */
  async uploadFile(uploadUrl: string, base64PDF: string): Promise<void> {
    const cleanBase64 = this.cleanBase64(base64PDF);
    const pdfBuffer = Buffer.from(cleanBase64, 'base64');

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: pdfBuffer,
    });

    if (!response.ok) {
      throw new Error(`File upload failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * check the status and get results of a batch task
   */
  async getBatchResult(batchId: string): Promise<MineraBatchResultResponse['data']> {
    if (!this.isEnabled()) {
      throw new Error('Mineru service is not enabled');
    }

    const response = await fetch(`${this.apiUrl}/extract-results/batch/${batchId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Mineru batch result query failed: ${response.status} ${response.statusText}`);
    }

    const result: MineraBatchResultResponse = await response.json();
    
    if (result.code !== 0) {
      throw new Error(`Mineru batch result query failed: ${result.msg}`);
    }

    return result.data;
  }

  /**
   * wait for a batch task to complete
   */
  async waitForBatchCompletion(batchId: string, maxWaitTime = 300000): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < maxWaitTime) {
      const result = await this.getBatchResult(batchId);
      
      if (!result.extract_result || result.extract_result.length === 0) {
        throw new Error('No extraction results found');
      }

      const fileResult = result.extract_result[0];
      
      if (fileResult.state === 'done') {
        if (!fileResult.full_zip_url) {
          throw new Error('Task completed but no download URL provided');
        }
        return fileResult.full_zip_url;
      }
      
      if (fileResult.state === 'failed') {
        throw new Error(`Task failed: ${fileResult.err_msg || 'Unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Task timeout: Processing took too long');
  }

  /**
   * download and parse the result ZIP file
   */
  async downloadAndParseResult(zipUrl: string): Promise<PDFConversionResult> {
    const response = await fetch(zipUrl);
    if (!response.ok) {
      throw new Error(`Failed to download result: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return await this.parseZipContent(arrayBuffer);
  }

  /**
   * Parse the content of the ZIP file
   * This function extracts markdown and images from the ZIP file.
   */
  private async parseZipContent(zipBuffer: ArrayBuffer): Promise<PDFConversionResult> {
    try {
      console.log('Starting real ZIP content parsing...');
      
      const { markdownContent, images } = await this.extractZipContent(zipBuffer);
      
      let finalMarkdown = markdownContent;
      if (!finalMarkdown.trim()) {
        if (images.length > 0) {
          finalMarkdown = `# PDF Content\n\nThis PDF contains ${images.length} image(s). The images have been extracted and can be processed by vision-capable models.\n`;
          images.forEach((img, index) => {
            finalMarkdown += `\n## Image ${index + 1}: ${img.name}\n`;
            if (img.pageNumber) {
              finalMarkdown += `- Page: ${img.pageNumber}\n`;
            }
          });
        } else {
          finalMarkdown = '# PDF Content\n\nNo readable content found in this PDF.';
        }
      }
      
      const result: PDFConversionResult = {
        markdown: finalMarkdown,
        images: images,
        metadata: {
          pageCount: Math.max(1, ...images.map(img => img.pageNumber || 1)),
          processingTime: Date.now(),
          title: this.extractTitleFromMarkdown(finalMarkdown),
        },
      };
      
      console.log(`ZIP parsing successful: ${result.markdown.length} chars markdown, ${result.images.length} images`);
      return result;
      
    } catch (error) {
      console.error('Error parsing ZIP content:', error);
      
      return {
        markdown: `# PDF Processing Error\n\nFailed to parse PDF content: ${error instanceof Error ? error.message : 'Unknown error'}\n\nThis may be due to an unsupported PDF format or corrupted file.`,
        images: [],
        metadata: {
          pageCount: 1,
          processingTime: Date.now(),
        },
      };
    }
  }

  private async extractZipContent(zipBuffer: ArrayBuffer): Promise<{
    markdownContent: string;
    images: ProcessedImage[];
  }> {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(zipBuffer);
      
      yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(new Error(`Failed to open ZIP file: ${err.message}`));
          return;
        }

        if (!zipfile) {
          reject(new Error('Failed to create zipfile instance'));
          return;
        }

        const images: ProcessedImage[] = [];
        let markdownContent = '';
        let processedEntries = 0;
        let totalEntries = 0;

        const countEntries = () => {
          zipfile.readEntry();
        };

        zipfile.on('entry', (_entry) => {
          totalEntries++;
          zipfile.readEntry();
        });

        zipfile.on('end', () => {
          yauzl.fromBuffer(buffer, { lazyEntries: true }, (err2, zipfile2) => {
            if (err2 || !zipfile2) {
              reject(new Error('Failed to reopen ZIP file for processing'));
              return;
            }

            zipfile2.readEntry();

            zipfile2.on('entry', (entry) => {
              const fileName = entry.fileName;
              console.log(`Processing ZIP entry: ${fileName}`);

              if (fileName.endsWith('/')) {
                processedEntries++;
                if (processedEntries >= totalEntries) {
                  resolve({ markdownContent, images });
                } else {
                  zipfile2.readEntry();
                }
                return;
              }

              zipfile2.openReadStream(entry, (err, readStream) => {
                if (err) {
                  console.error(`Error reading ${fileName}:`, err);
                  processedEntries++;
                  if (processedEntries >= totalEntries) {
                    resolve({ markdownContent, images });
                  } else {
                    zipfile2.readEntry();
                  }
                  return;
                }

                if (!readStream) {
                  console.error(`No read stream for ${fileName}`);
                  processedEntries++;
                  if (processedEntries >= totalEntries) {
                    resolve({ markdownContent, images });
                  } else {
                    zipfile2.readEntry();
                  }
                  return;
                }

                const chunks: Buffer[] = [];
                
                readStream.on('data', (chunk) => {
                  chunks.push(chunk);
                });

                readStream.on('end', () => {
                  const fileContent = Buffer.concat(chunks);
                  
                  try {
                    if (fileName.endsWith('.md') || fileName.endsWith('.markdown')) {
                      markdownContent += fileContent.toString('utf8') + '\n\n';
                      console.log(`Found markdown file: ${fileName}, length: ${fileContent.length}`);
                    } 
                    else if (fileName.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
                      const base64Data = fileContent.toString('base64');
                      const mimeType = this.getMimeTypeFromExtension(fileName);
                      
                      images.push({
                        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        name: fileName,
                        type: mimeType,
                        data: base64Data,
                        pageNumber: this.extractPageNumberFromFileName(fileName),
                      });
                      
                      console.log(`Found image: ${fileName}, size: ${fileContent.length} bytes`);
                    }
                    else if (fileName.endsWith('.json')) {
                      try {
                        const jsonData = JSON.parse(fileContent.toString('utf8'));
                        console.log(`Found metadata JSON: ${fileName}`, Object.keys(jsonData));
                      } catch (jsonErr) {
                        console.warn(`Failed to parse JSON ${fileName}:`, jsonErr);
                      }
                    }
                    else {
                      console.log(`Skipping unknown file type: ${fileName}`);
                    }
                  } catch (parseError) {
                    console.error(`Error processing ${fileName}:`, parseError);
                  }

                  processedEntries++;
                  
                  if (processedEntries >= totalEntries) {
                    console.log(`ZIP parsing complete. Found ${images.length} images, markdown length: ${markdownContent.length}`);
                    resolve({ markdownContent, images });
                  } else {
                    zipfile2.readEntry();
                  }
                });

                readStream.on('error', (streamErr) => {
                  console.error(`Stream error for ${fileName}:`, streamErr);
                  processedEntries++;
                  if (processedEntries >= totalEntries) {
                    resolve({ markdownContent, images });
                  } else {
                    zipfile2.readEntry();
                  }
                });
              });
            });

            zipfile2.on('end', () => {
              if (totalEntries === 0) {
                console.log('ZIP file is empty');
                resolve({ markdownContent: '', images: [] });
              }
            });

            zipfile2.on('error', (zipErr) => {
              console.error('ZIP file error:', zipErr);
              reject(zipErr);
            });
          });
        });

        countEntries();
      });
    });
  }

  private getMimeTypeFromExtension(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'bmp':
        return 'image/bmp';
      default:
        return 'image/jpeg';
    }
  }

  private extractPageNumberFromFileName(fileName: string): number | undefined {
    const match = fileName.match(/page[_-]?(\d+)|(\d+)[_-]?page/i);
    return match ? parseInt(match[1] || match[2]) : undefined;
  }

  /**
   * extract title from markdown content
   */
  private extractTitleFromMarkdown(markdown: string): string | undefined {
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    return titleMatch ? titleMatch[1].trim() : undefined;
  }

  /**
   * Full process to convert PDF to Markdown with images
   */
  async convertPDFToMarkdownWithImages(base64PDF: string): Promise<PDFConversionResult> {
    try {
      const fileName = `document_${Date.now()}.pdf`;
      const { batchId, uploadUrl } = await this.requestUploadUrl(fileName);
      
      await this.uploadFile(uploadUrl, base64PDF);
      
      const zipUrl = await this.waitForBatchCompletion(batchId);
      
      const result = await this.downloadAndParseResult(zipUrl);
      
      return result;
    } catch (error) {
      console.error('Mineru PDF conversion failed:', error);
      throw error;
    }
  }

  /**
   * clean up base64 string by removing data URL prefix
   */
  private cleanBase64(base64String: string): string {
    return base64String.replace(/^data:.*?;base64,/, '');
  }
}