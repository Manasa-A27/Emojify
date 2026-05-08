import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const searchTool = {
  name: "googleSearch",
  parameters: {
    type: "OBJECT",
    properties: {
      query: {
        type: "STRING",
        description: "The search query to verify facts or find more information."
      }
    },
    required: ["query"]
  }
};

async function analyzeDocuments(files, userPrompt) {
  const model = "gemini-3.1-pro-preview";

  const fileParts = files.map(f => ({
    inlineData: {
      data: f.data,
      mimeType: f.mimeType
    }
  }));

  const systemInstruction = `
    You are a world-class Multimodal AI Research Assistant acting as a skeptical auditor. 
    Your task is to analyze the provided documents with a critical eye, looking for inconsistencies, risks, and hidden patterns.
    
    Guidelines:
    1. Extract data from tables and images accurately.
    2. Provide a structured Executive Summary:
       - TL;DR: Exactly 2 sentences summarizing the core message.
       - Key Insights: Bullet points of the most critical findings.
       - Detected Risks or Red Flags: Explicitly list any risks, contradictions, or suspicious data points.
       - Overall Sentiment Score: A score from 0 to 10 (0 being extremely negative/risky, 10 being extremely positive/safe).
    3. If multiple documents are provided, synthesize a comparative analysis. Create a Markdown table comparing key metrics (revenue, risk, growth) across all documents. Highlight the document with the strongest performance in bold.
    4. **Fact Verification (CRITICAL)**:
       - Identify the most 'ambitious' or 'factual' claim in the user's document.
       - Generate a targeted Google Search query to verify this specific claim.
       - Use the googleSearch tool to execute the query.
       - Compare the web results with the document's claim.
       - Provide a 'Truth Score' (0-100) and a detailed 'explanation' of any discrepancies or confirmations.
    5. Identify numerical data that can be visualized in a chart.
    6. Cite specific sources (document name and page if available).
    
    Output Format:
    Return a JSON object matching this structure:
    {
      "summary": "TL;DR (2 sentences)",
      "comparativeAnalysis": "Markdown table comparing documents...",
      "keyFindings": ["Insight 1", "Insight 2"],
      "risks": ["Risk 1", "Risk 2"],
      "sentimentScore": 7.5,
      "dataPoints": [{"label": "...", "value": 0}, ...],
      "sources": [{"title": "...", "page": 0, "snippet": "..."}],
      "verifications": [
        {
          "claim": "The most ambitious/factual claim...",
          "status": "verified|unverified|contradicted",
          "source": "Web source URL or title",
          "truthScore": 85,
          "explanation": "Detailed comparison and discrepancy analysis...",
          "searchQuery": "The query used for verification"
        }
      ],
      "metrics": {
        "totalPages": 0,
        "readingTime": "e.g. 5 min",
        "complexity": "Low|Medium|High",
        "confidenceScore": 0.95
      },
      "topics": ["Topic A", "Topic B"]
    }
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [
      { role: 'user', parts: [...fileParts, { text: userPrompt }] }
    ],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    throw new Error("Failed to analyze documents. Please try again.");
  }
}

async function chatWithDocuments(history, newPrompt, files) {
  const model = "gemini-3.1-pro-preview";
  
  const fileParts = files.map(f => ({
    inlineData: {
      data: f.data,
      mimeType: f.mimeType
    }
  }));

  const response = await ai.models.generateContent({
    model,
    contents: [
      ...history,
      { role: 'user', parts: [...fileParts, { text: newPrompt }] }
    ],
    config: {
      systemInstruction: `You are a world-class Research Assistant. 
    Your primary goal is to answer questions using ONLY the provided document context.
    
    Strict Rules:
    1. Answer using ONLY the provided context. If the answer is not in the documents, state that you cannot find the information.
    2. For EVERY claim you make, you MUST cite the source in brackets like [Source Name, Page Number].
    3. Do NOT use outside knowledge unless specifically asked to perform a web search.
    4. If you use the googleSearch tool, clearly distinguish between document context and web search results.`,
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true }
    }
  });

  return response.text;
}
