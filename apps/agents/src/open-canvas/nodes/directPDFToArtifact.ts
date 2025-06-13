import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { OpenCanvasGraphAnnotation, OpenCanvasGraphReturnType } from "../state.js";
import { ArtifactV3 } from "@opencanvas/shared/types";

/**
 * 直接将 PDF 提取的 Markdown 内容转换为 Artifact，不经过 AI 处理
 */
export const directPDFToArtifact = async (
  state: typeof OpenCanvasGraphAnnotation.State,
  config: LangGraphRunnableConfig
): Promise<OpenCanvasGraphReturnType> => {
  
  if (!state.directPDFMarkdown) {
    throw new Error("No direct PDF markdown content found");
  }

  const { markdown, fileName } = state.directPDFMarkdown;

  // 直接创建 Markdown Artifact
  const newArtifact: ArtifactV3 = {
    currentIndex: 1,
    contents: [
      {
        index: 1,
        type: "text",
        title: fileName.replace('.pdf', ''), // 移除 .pdf 副档名
        fullMarkdown: markdown,
      }
    ],
  };

  return {
    artifact: newArtifact,
    // 清除 PDF 状态
    directPDFMarkdown: undefined,
  };
};