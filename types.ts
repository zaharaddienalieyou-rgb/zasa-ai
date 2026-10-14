export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  detectedLang?: 'hausa' | 'arabic' | 'french' | 'english' | 'other';
  isError?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
  samplePrompt: string;
  description: string;
}
