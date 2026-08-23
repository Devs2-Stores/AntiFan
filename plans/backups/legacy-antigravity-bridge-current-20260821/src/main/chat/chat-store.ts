import {
  ChatRecord,
  makeControlPlaneId,
  validateControlPlaneId,
} from '../../shared/control-plane-contracts';
import { ChatMessage } from '../../shared/contracts';

export interface ControlPlaneChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  runId?: string;
}

export class ChatStore {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly messages = new Map<string, ControlPlaneChatMessage[]>();

  create(projectId: string, workspaceId: string, title = 'Theme QA'): ChatRecord {
    const now = Date.now();
    const chat: ChatRecord = {
      id: makeControlPlaneId('chat'), projectId: validateControlPlaneId(projectId, 'project'), workspaceId: validateControlPlaneId(workspaceId, 'workspace'), title: title.trim() || 'Chat', state: 'open', createdAt: now, updatedAt: now,
    };
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    return { ...chat };
  }

  get(chatId: string, projectId?: string, workspaceId?: string): ChatRecord {
    const chat = this.chats.get(validateControlPlaneId(chatId, 'chat'));
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    if (projectId && chat.projectId !== validateControlPlaneId(projectId, 'project')) throw new Error('Chat does not belong to Project');
    if (workspaceId && chat.workspaceId !== validateControlPlaneId(workspaceId, 'workspace')) throw new Error('Chat does not belong to Workspace');
    return { ...chat };
  }

  close(chatId: string, projectId: string): ChatRecord {
    const chat = this.get(chatId, projectId);
    chat.state = 'closed';
    chat.updatedAt = Date.now();
    this.chats.set(chat.id, chat);
    return { ...chat };
  }

  appendMessage(chatId: string, message: Omit<ControlPlaneChatMessage, 'id' | 'chatId' | 'createdAt'>): ControlPlaneChatMessage {
    const chat = this.get(chatId);
    if (chat.state !== 'open') throw new Error('Cannot append to a closed Chat');
    const item: ControlPlaneChatMessage = { ...message, id: makeControlPlaneId('attempt'), chatId: chat.id, createdAt: Date.now() };
    const messages = this.messages.get(chat.id) || [];
    messages.push(item);
    this.messages.set(chat.id, messages);
    chat.updatedAt = item.createdAt;
    this.chats.set(chat.id, chat);
    return { ...item };
  }

  listMessages(chatId: string, projectId?: string): ControlPlaneChatMessage[] {
    const chat = this.get(chatId, projectId);
    return (this.messages.get(chat.id) || []).map((item) => ({ ...item }));
  }

  projectMessages(chatId: string, projectId?: string): ChatMessage[] {
    return this.listMessages(chatId, projectId).map((item) => ({ id: item.id, role: item.role, text: item.text, timestamp: item.createdAt }));
  }
}
