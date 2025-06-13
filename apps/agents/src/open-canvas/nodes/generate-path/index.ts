import { extractUrls } from "@opencanvas/shared/utils/urls";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  OpenCanvasGraphAnnotation,
  OpenCanvasGraphReturnType,
} from "../../state.js";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { dynamicDeterminePath } from "./dynamic-determine-path.js";
import {
  convertContextDocumentToHumanMessage,
  fixMisFormattedContextDocMessage,
} from "./documents.js";
import { getStringFromContent } from ".././../../utils.js";
import { includeURLContents } from "./include-url-contents.js";

function extractURLsFromLastMessage(messages: BaseMessage[]): string[] {
  const recentMessage = messages[messages.length - 1];
  const recentMessageContent = getStringFromContent(recentMessage.content);
  const messageUrls = extractUrls(recentMessageContent);
  return messageUrls;
}

/**
 * Routes to the proper node in the graph based on the user's query.
 */
export async function generatePath(
  state: typeof OpenCanvasGraphAnnotation.State,
  config: LangGraphRunnableConfig
): Promise<OpenCanvasGraphReturnType> {
  const { _messages } = state;
  const newMessages: BaseMessage[] = [];
  const docMessage = await convertContextDocumentToHumanMessage(
    _messages,
    config
  );
  
  // 檢查是否有 PDF 文檔被處理
  if (docMessage) {
    newMessages.push(docMessage);
    
    // 檢查是否包含 PDF 內容
    const pdfContent = docMessage.content.find((content: any) => 
      typeof content === 'object' && 
      content.type === 'text' && 
      content.text?.includes('PDF Content:')
    );
    
    if (pdfContent) {
      // 直接提取 PDF 的 Markdown 內容
      const markdownContent = pdfContent.text.replace('PDF Content:\n\n', '');
      const fileName = extractPDFFileName(_messages);
      
      const directPDFContent = {
        markdown: markdownContent,
        fileName: fileName
      };

      // 硬編碼判斷：檢查用戶是否只上傳 PDF 沒有附加文字
      const hasUserText = checkUserHasAdditionalText(_messages);

      if (!hasUserText) {
        // 用戶只上傳 PDF，沒有附加文字 → 直接顯示
        return {
          next: "directPDFToArtifact",
          directPDFMarkdown: directPDFContent,
          messages: newMessages,
          _messages: newMessages,
        };
      } else {
        // 用戶有附加文字指示 → AI 處理
        return {
          next: state.artifact ? "rewriteArtifact" : "generateArtifact",
          messages: newMessages,
          _messages: newMessages,
        };
      }
    }
  }
    
  const existingDocMessage = newMessages.find(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (c) => c.type === "document" || c.type === "application/pdf"
      )
  );

  if (docMessage) {
    newMessages.push(docMessage);
  } else if (existingDocMessage) {
    const fixedMessages = await fixMisFormattedContextDocMessage(
      existingDocMessage,
      config
    );
    if (fixedMessages) {
      newMessages.push(...fixedMessages);
    }
  }

  if (state.highlightedCode) {
    return {
      next: "updateArtifact",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }
  if (state.highlightedText) {
    return {
      next: "updateHighlightedText",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }

  if (
    state.language ||
    state.artifactLength ||
    state.regenerateWithEmojis ||
    state.readingLevel
  ) {
    return {
      next: "rewriteArtifactTheme",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }

  if (
    state.addComments ||
    state.addLogs ||
    state.portLanguage ||
    state.fixBugs
  ) {
    return {
      next: "rewriteCodeArtifactTheme",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }

  if (state.customQuickActionId) {
    return {
      next: "customAction",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }

  if (state.webSearchEnabled) {
    return {
      next: "webSearch",
      ...(newMessages.length
        ? { messages: newMessages, _messages: newMessages }
        : {}),
    };
  }

  // Check if any URLs are in the latest message. If true, determine if the contents should be included
  // inline in the prompt, and if so, scrape the contents and update the prompt.
  const messageUrls = extractURLsFromLastMessage(state._messages);
  let updatedMessageWithContents: HumanMessage | undefined = undefined;
  if (messageUrls.length) {
    updatedMessageWithContents = await includeURLContents(
      state._messages[state._messages.length - 1],
      messageUrls
    );
  }

  // Update the internal message list with the new message, if one was generated
  const newInternalMessageList = updatedMessageWithContents
    ? state._messages.map((m) => {
        if (m.id === updatedMessageWithContents.id) {
          return updatedMessageWithContents;
        } else {
          return m;
        }
      })
    : state._messages;

  const routingResult = await dynamicDeterminePath({
    state: {
      ...state,
      _messages: newInternalMessageList,
    },
    newMessages,
    config,
  });
  const route = routingResult?.route;
  if (!route) {
    throw new Error("Route not found");
  }

  // Create the messages object including the new messages if any
  const messages = newMessages.length
    ? {
        messages: newMessages,
        _messages: [...newInternalMessageList, ...newMessages],
      }
    : {
        _messages: newInternalMessageList,
      };

  return {
    next: route,
    ...messages,
  };
}

// 輔助函數：從消息中提取 PDF 檔案名稱
function extractPDFFileName(messages: BaseMessage[]): string {
  const recentMessages = messages.slice(-3);
  
  for (const message of recentMessages.reverse()) {
    if (message.additional_kwargs?.documents) {
      const documents = message.additional_kwargs.documents;
      const pdfDoc = documents.find((doc: any) => 
        doc.type === 'application/pdf' || doc.name?.endsWith('.pdf')
      );
      if (pdfDoc?.name) {
        return pdfDoc.name;
      }
    }
  }
  
  return 'PDF Document';
}

// 輔助函數：檢查用戶是否有附加文字（硬編碼邏輯）
function checkUserHasAdditionalText(messages: BaseMessage[]): boolean {
  // 檢查最後一條用戶消息
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.getType() !== 'human') {
    return false;
  }

  // 獲取消息的文字內容
  const messageContent = getStringFromContent(lastMessage.content);
  
  // 如果消息內容為空或只有空白字符，視為沒有附加文字
  if (!messageContent || messageContent.trim().length === 0) {
    return false;
  }

  // 系統不支持用戶在附加檔案的情況下送出空字串
  // 所以如果有內容，就表示用戶有附加指示
  return true;
}
