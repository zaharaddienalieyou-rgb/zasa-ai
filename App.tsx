import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { ConfigModal } from './components/ConfigModal';
import { ChatSession, ChatMessage as ChatMessageType } from './types';
import { detectLanguage } from './utils/language';
import { Sparkles, Bot, AlertTriangle } from 'lucide-react';

const STORAGE_KEY = 'zasa_ai_sessions_v1';
const ACTIVE_SESSION_KEY = 'zasa_ai_active_session_id';

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_SESSION_KEY) || null;
    } catch {
      return null;
    }
  });

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [backendHealth, setBackendHealth] = useState<{ hasKey: boolean } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sync sessions with localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (err) {
      console.warn('Could not save sessions to localStorage:', err);
    }
  }, [sessions]);

  // Sync activeSessionId with localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }, [activeSessionId]);

  // Check backend health and API key presence
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        setBackendHealth({ hasKey: data.hasApiKey });
      })
      .catch((err) => {
        console.warn('Backend health check error:', err);
      });
  }, []);

  // Find active session
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession ? activeSession.messages : [];

  // Scroll to bottom smoothly
  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  useEffect(() => {
    scrollToBottom(false);
  }, [activeSessionId]);

  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, isLoading]);

  // Start new chat
  const handleNewChat = () => {
    setActiveSessionId(null);
    setInput('');
  };

  // Select existing session
  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
  };

  // Delete session
  const handleDeleteSession = (id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
  };

  // Clear all sessions
  const handleClearAll = () => {
    setSessions([]);
    setActiveSessionId(null);
  };

  // Send message
  const handleSend = async (customPrompt?: string) => {
    const textToSend = (customPrompt || input).trim();
    if (!textToSend || isLoading) return;

    setInput('');

    const detectedUserLang = detectLanguage(textToSend);

    const userMessage: ChatMessageType = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: textToSend,
      timestamp: Date.now(),
      detectedLang: detectedUserLang,
    };

    let targetSessionId = activeSessionId;
    let currentMessages: ChatMessageType[] = [];

    if (!targetSessionId || !activeSession) {
      // Create new session
      const newSessionId = `session-${Date.now()}`;
      // Clean title from prompt
      const title = textToSend.slice(0, 36) + (textToSend.length > 36 ? '...' : '');
      const newSession: ChatSession = {
        id: newSessionId,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [userMessage],
      };
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSessionId);
      targetSessionId = newSessionId;
      currentMessages = [userMessage];
    } else {
      currentMessages = [...activeSession.messages, userMessage];
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetSessionId
            ? { ...s, messages: currentMessages, updatedAt: Date.now() }
            : s
        )
      );
    }

    // Add empty assistant response to stream into
    const assistantMessageId = `assistant-${Date.now()}`;
    const initialAssistantMessage: ChatMessageType = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    setSessions((prev) =>
      prev.map((s) =>
        s.id === targetSessionId
          ? {
              ...s,
              messages: [...currentMessages, initialAssistantMessage],
              updatedAt: Date.now(),
            }
          : s
      )
    );

    setIsLoading(true);

    try {
      // Request streaming response from backend
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: currentMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
        }),
      });

      if (!response.ok) {
        let errMessage = 'Unable to connect to ZASA AI.';
        try {
          const errData = await response.json();
          errMessage = errData.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }

      if (!response.body) {
        throw new Error('No streaming response body received from server.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';
      let buffer = '';
      let streamError: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;

          const lines = trimmed.split('\n');
          for (const line of lines) {
            const lineTrimmed = line.trim();
            if (lineTrimmed.startsWith('data: ')) {
              const dataStr = lineTrimmed.slice(6).trim();
              if (dataStr === '[DONE]') {
                break;
              }

              let parsed: any = null;
              try {
                parsed = JSON.parse(dataStr);
              } catch {
                // If the stream sent raw plain text
                if (dataStr && !dataStr.startsWith('{')) {
                  accumulatedText += dataStr;
                }
              }

              if (parsed) {
                if (parsed.error) {
                  streamError = parsed.error;
                  break;
                }
                if (typeof parsed.text === 'string' && parsed.text.length > 0) {
                  accumulatedText += parsed.text;
                }
              }

              // Update message in real time
              if (accumulatedText) {
                setSessions((prev) =>
                  prev.map((s) => {
                    if (s.id !== targetSessionId) return s;
                    return {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantMessageId
                          ? { ...m, content: accumulatedText }
                          : m
                      ),
                    };
                  })
                );
              }
            }
          }

          if (streamError) break;
        }

        if (streamError) break;
      }

      // Check remaining buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) streamError = parsed.error;
              if (parsed.text) accumulatedText += parsed.text;
            } catch {}
          }
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (!accumulatedText.trim()) {
        throw new Error('ZASA AI received an empty response. Please click Retry to ask again.');
      }

      // Finalize message and tag language
      const detectedRespLang = detectLanguage(accumulatedText);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: accumulatedText,
                    detectedLang: detectedRespLang,
                    isError: false,
                  }
                : m
            ),
          };
        })
      );
    } catch (error: any) {
      console.error('Error in chat loop:', error);
      const friendlyError =
        error?.message ||
        'An unexpected error occurred while communicating with ZASA AI. Please check server settings or try again.';

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: friendlyError,
                    isError: true,
                  }
                : m
            ),
          };
        })
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Regenerate last assistant response
  const handleRegenerate = async () => {
    if (!activeSession || activeSession.messages.length < 2 || isLoading) return;

    // Find last user message
    const msgs = activeSession.messages;
    const lastUserMsgIndex = [...msgs]
      .map((m, idx) => ({ role: m.role, idx }))
      .filter((m) => m.role === 'user')
      .pop();

    if (!lastUserMsgIndex) return;

    // Remove any assistant message after it
    const trimmedMessages = msgs.slice(0, lastUserMsgIndex.idx + 1);
    const lastUserPrompt = msgs[lastUserMsgIndex.idx].content;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id ? { ...s, messages: trimmedMessages } : s
      )
    );

    // Re-send with that prompt
    handleSend(lastUserPrompt);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#061a14] text-slate-100 font-sans">
      {/* Sidebar with Chat History */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onClearAll={handleClearAll}
        onSelectStarterPrompt={(prompt) => {
          handleSend(prompt);
        }}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-gradient-to-b from-[#061a14] via-[#051812] to-[#04130e]">
        {/* Top Header */}
        <Header
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          onNewChat={handleNewChat}
          onOpenInfo={() => setInfoModalOpen(true)}
          chatCount={sessions.length}
        />

        {/* Missing API Key Banner Notification (if server detects key is unconfigured) */}
        {backendHealth && !backendHealth.hasKey && (
          <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-200 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
              <span>
                <strong>Gemini API key note:</strong> Configure your GEMINI_API_KEY in Settings &gt; Secrets to enable AI answers.
              </span>
            </div>
            <button
              onClick={() => setInfoModalOpen(true)}
              className="underline text-yellow-300 hover:text-white"
            >
              Learn more
            </button>
          </div>
        )}

        {/* Message Area */}
        <main className="flex-1 overflow-y-auto overscroll-contain flex flex-col">
          {messages.length === 0 ? (
            <WelcomeScreen onSelectPrompt={(prompt) => handleSend(prompt)} />
          ) : (
            <div className="py-4 space-y-2 max-w-4xl mx-auto w-full">
              {messages.map((message, index) => {
                const isLatestAssistant =
                  message.role === 'assistant' && index === messages.length - 1;
                return (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    isLatestAssistantMessage={isLatestAssistant}
                    onRegenerate={handleRegenerate}
                  />
                );
              })}

              {/* Streaming loading indicator when awaiting first token */}
              {isLoading && messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]?.content && (
                <div className="flex items-center gap-3 px-3 sm:px-6 my-2">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-600 to-emerald-950 border border-yellow-500/40 flex items-center justify-center shadow-xs">
                    <span className="font-bold text-xs text-yellow-300 animate-pulse">Z</span>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-[#082119] border border-emerald-800/60 text-xs text-emerald-300">
                    <span className="w-2 h-2 rounded-full bg-yellow-400 animate-ping" />
                    <span>ZASA AI is thinking...</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </main>

        {/* Bottom Chat Input */}
        <ChatInput
          input={input}
          setInput={setInput}
          onSend={handleSend}
          isLoading={isLoading}
        />
      </div>

      {/* Info & Settings Modal */}
      <ConfigModal
        isOpen={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        apiKeyStatus={backendHealth?.hasKey ?? true}
      />
    </div>
  );
}
