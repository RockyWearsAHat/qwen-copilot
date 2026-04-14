import * as vscode from 'vscode';

declare module 'vscode' {
  export interface ChatProvider {
    provideChatResponse(
      request: any,
      context: any,
      stream: any,
      token: any
    ): any;
  }

  export namespace chat {
    function registerChatProvider(
      id: string,
      provider: ChatProvider,
      metadata: {
        displayName: string;
        description?: string;
      }
    ): vscode.Disposable;
  }
}