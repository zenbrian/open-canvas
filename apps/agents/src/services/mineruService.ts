import { config } from 'dotenv';
import { join } from 'path';
import JSZip from 'jszip';

// load env 
try {
  const rootDir = join(process.cwd(), '..', '..');
  const envPath = join(rootDir, '.env');
  config({ path: envPath });
} catch (error) {
  config();
}

// 保持與原版相容的介面
export interface ProcessedImage {
  id: string;
  name: string;
  type: string;
  data: string; // base64
  pageNumber?: number;
}

export interface PDFConversionResult {
  markdown: string;
  images: ProcessedImage[]; // 保持原介面，但實際會是空陣列
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
    this.apiUrl = process.env.MINERU_API_URL || 'https://mineru.net/api/v4';
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
   * download and parse the result ZIP file (僅 Markdown)
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
   * Parse the content of the ZIP file (僅提取 Markdown)
   */
  private async parseZipContent(zipBuffer: ArrayBuffer): Promise<PDFConversionResult> {
    try {
      console.log('開始解析 ZIP 檔案...');
      
      const zip = new JSZip();
      const zipContents = await zip.loadAsync(zipBuffer);

      // 尋找 Markdown 檔案
      let markdownContent = '';
      
      // find full.md
      const fullMdFile = zipContents.file('full.md');
      if (fullMdFile) {
        markdownContent = await fullMdFile.async('text');
        console.log(`找到 full.md，長度: ${markdownContent.length} 字符`);
      } else {
        throw new Error(`Failed to find full.md in ZIP file`);
      }

      if (!markdownContent.trim()) {
        markdownContent = '# PDF 內容\n\n無法提取可讀內容，這可能是因為 PDF 格式不支援或檔案損壞。';
      }
      
      const result: PDFConversionResult = {
        markdown: markdownContent,
        images: [], // 空陣列，保持介面相容性
        metadata: {
          pageCount: 1, // 預設值
          processingTime: Date.now(),
          title: this.extractTitleFromMarkdown(markdownContent),
        },
      };
      
      console.log(`ZIP 解析成功: ${result.markdown.length} 字符 markdown`);
      return result;
      
    } catch (error) {
      console.error('解析 ZIP 檔案失敗:', error);
      
      return {
        markdown: `# PDF 處理錯誤\n\n無法解析 PDF 內容: ${error instanceof Error ? error.message : '未知錯誤'}\n\n這可能是因為 PDF 格式不支援或檔案損壞。`,
        images: [], // 空陣列，保持介面相容性
        metadata: {
          pageCount: 1,
          processingTime: Date.now(),
        },
      };
    }
  }

  /**
   * extract title from markdown content
   */
  private extractTitleFromMarkdown(markdown: string): string | undefined {
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    return titleMatch ? titleMatch[1].trim() : undefined;
  }

  /**
   * Full process to convert PDF to Markdown (簡化版本)
   */
  async convertPDFToMarkdown(base64PDF: string): Promise<PDFConversionResult> {
    try {
      const fileName = `document_${Date.now()}.pdf`;
      const { batchId, uploadUrl } = await this.requestUploadUrl(fileName);
      
      console.log(`開始上傳 PDF: ${fileName}`);
      await this.uploadFile(uploadUrl, base64PDF);
      
      console.log(`等待處理完成: ${batchId}`);
      const zipUrl = await this.waitForBatchCompletion(batchId);
      
      console.log(`下載並解析結果...`);
      const result = await this.downloadAndParseResult(zipUrl);
      
      return result;
    } catch (error) {
      console.error('Mineru PDF 轉換失敗:', error);
      throw error;
    }
  }

  /**
   * clean up base64 string by removing data URL prefix
   */
  private cleanBase64(base64String: string): string {
    return base64String.replace(/^data:.*?;base64,/, '');
  }

  // 保持與原版相容的方法名稱
  async convertPDFToMarkdownWithImages(base64PDF: string): Promise<PDFConversionResult> {
    return this.convertPDFToMarkdown(base64PDF);
  }
}