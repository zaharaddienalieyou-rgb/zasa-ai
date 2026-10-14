import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: '10mb' }));

// Helper to initialize GoogleGenAI safely on server
function getGenAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const SYSTEM_INSTRUCTION = `You are ZASA AI, an advanced, highly capable, and visionary AI chatbot assistant.
Brand name: ZASA AI
Slogan: "Your Vision. Your Intelligence. Your Future."

Core Identity and Rules:
1. Multilingual Native Fluency:
   - You natively and expertly communicate in Hausa, English, Arabic (العربية), and French (Français), as well as any other world language.
   - AUTOMATIC LANGUAGE MATCHING: Always automatically detect the language used in the user's latest prompt and reply in that EXACT same language with native phrasing, natural grammar, and cultural respect.
   - If the user explicitly asks for a specific language (e.g. "Say this in Hausa", "Translate to Arabic", "Explain in French"), honor their request immediately.
   
2. Language-Specific Guidelines:
   - Hausa: Use authentic, fluent, and respectful Hausa (Kamar yadda aka saba a al'adance: girmamawa, kalmomi masu ma'ana, da sauki wajen fahimta. Misali: "Barka! Ina nan domin taimaka maka...").
   - Arabic: Use polished, expressive Modern Standard Arabic (العربية الفصحى) with clear structure, or appropriate phrasing as guided by context.
   - French: Use articulate, sophisticated, and warm French with proper punctuation and accents.
   - English: Provide intelligent, articulate, inspiring, and concise yet thorough responses.

3. Formatting & Presentation:
   - Use clean Markdown with headings, bullet points, numbered lists, blockquotes, and code blocks with language labels whenever helpful.
   - When presenting code, make it clean, modern, and well-commented.
   - Be visionary, encouraging, and solutions-oriented, embodying "Your Vision. Your Intelligence. Your Future."
   - Do not claim to be ChatGPT or OpenAI. You are proudly ZASA AI.`;

// Health check endpoint
app.get('/api/health', (req, res) => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  res.json({
    status: 'ok',
    brand: 'ZASA AI',
    slogan: 'Your Vision. Your Intelligence. Your Future.',
    model: 'gemini-3.8-flash',
    hasApiKey: hasKey,
    timestamp: new Date().toISOString(),
  });
});

// Helper to extract text from chunk safely
function extractChunkText(chunk: any): string {
  if (typeof chunk.text === 'string' && chunk.text.length > 0) {
    return chunk.text;
  }
  if (chunk.candidates && chunk.candidates.length > 0) {
    const parts = chunk.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter((p: any) => typeof p.text === 'string' && !p.thought)
        .map((p: any) => p.text)
        .join('');
    }
  }
  return '';
}

// Helper to extract full text from non-streaming response safely
function extractResponseText(response: any): string {
  if (typeof response.text === 'string' && response.text.trim().length > 0) {
    return response.text;
  }
  if (response.candidates && response.candidates.length > 0) {
    const parts = response.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter((p: any) => typeof p.text === 'string' && !p.thought)
        .map((p: any) => p.text)
        .join('');
    }
  }
  return '';
}

// Chat endpoint (supports streaming SSE or direct JSON response)
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, stream = true } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request: "messages" array is required and must not be empty.',
      });
    }

    let ai: GoogleGenAI;
    try {
      ai = getGenAI();
    } catch (err: any) {
      return res.status(503).json({
        error: 'Gemini API Key is not configured on the server. Please ensure GEMINI_API_KEY is configured in Settings > Secrets.',
        details: err?.message,
      });
    }

    // Format messages for @google/genai
    // role: 'user' | 'model'
    const formattedContents = messages
      .filter((m: any) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    if (formattedContents.length === 0) {
      return res.status(400).json({ error: 'No valid message content provided.' });
    }

    // High-availability candidate models
    const candidateModels = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-flash-latest',
      'gemini-3.1-flash-lite',
    ];

    if (stream) {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let success = false;
      let lastErrorMessage = '';

      for (const model of candidateModels) {
        try {
          const responseStream = await ai.models.generateContentStream({
            model,
            contents: formattedContents,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              temperature: 0.7,
            },
          });

          let streamedChars = 0;
          for await (const chunk of responseStream) {
            const text = extractChunkText(chunk);
            if (text) {
              streamedChars += text.length;
              res.write(`data: ${JSON.stringify({ text })}\n\n`);
            }
          }

          if (streamedChars > 0) {
            success = true;
            break;
          } else {
            console.warn(`Model ${model} completed stream but yielded 0 text characters.`);
          }
        } catch (err: any) {
          lastErrorMessage = err?.message || 'Error communicating with Gemini model.';
          console.warn(`Model ${model} stream error:`, lastErrorMessage);
        }
      }

      if (!success) {
        // Parse friendly error
        let friendly = lastErrorMessage || 'Unable to generate response.';
        if (friendly.includes('429') || friendly.toLowerCase().includes('quota')) {
          friendly = 'Gemini API Quota Limit Reached (429): Free tier quota limit reached. Please attach your API key in Settings > Secrets or click Retry in a moment.';
        } else if (friendly.includes('503') || friendly.toLowerCase().includes('high demand')) {
          friendly = 'Gemini Service Temporarily Busy (503): High demand on Google Gemini servers. Please click Retry in a moment.';
        }

        res.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      // Non-streaming with fallback
      let lastErrorMessage = '';
      for (const model of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: formattedContents,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              temperature: 0.7,
            },
          });

          const responseText = extractResponseText(response);
          if (responseText && responseText.trim().length > 0) {
            return res.json({
              role: 'assistant',
              content: responseText,
            });
          }
        } catch (err: any) {
          lastErrorMessage = err?.message || '';
          console.warn(`Model ${model} non-stream error:`, lastErrorMessage);
        }
      }

      let friendly = lastErrorMessage || 'Unable to generate response.';
      if (friendly.includes('429') || friendly.toLowerCase().includes('quota')) {
        friendly = 'Gemini API Quota Limit Reached (429): Free tier quota limit reached. Please attach your API key in Settings > Secrets or click Retry in a moment.';
      } else if (friendly.includes('503') || friendly.toLowerCase().includes('high demand')) {
        friendly = 'Gemini Service Temporarily Busy (503): High demand on Google Gemini servers. Please click Retry in a moment.';
      }

      return res.status(503).json({ error: friendly });
    }
  } catch (error: any) {
    console.error('API /api/chat error:', error);
    return res.status(500).json({
      error: error?.message || 'An unexpected error occurred while communicating with ZASA AI.',
    });
  }
});

// Setup Vite middleware in dev or static files in production
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZASA AI Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ZASA AI server:', err);
  process.exit(1);
});
