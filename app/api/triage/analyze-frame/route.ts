import { streamObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  VisualAnalysisSchema,
  FrameAnalysisRequestSchema,
  VISUAL_TRIAGE_SYSTEM_PROMPT
} from "@/lib/schemas/video-triage";

// Validate environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Create Google AI provider instance
const google = createGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    console.log("🔬 [API] Received frame analysis request");

    // Verify authentication
    const { userId } = await auth();
    if (!userId) {
      console.error("❌ [API] Unauthorized - no userId");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("✅ [API] User authenticated:", userId);

    // Validate API key
    if (!GEMINI_API_KEY) {
      console.error("❌ [API] GEMINI_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("✅ [API] Gemini API key configured");

    // Parse and validate request
    const body = await request.json();
    console.log("📦 [API] Request body:", {
      sessionId: body.sessionId,
      frameSize: body.frameBase64?.length,
      hasPatientContext: !!body.patientContext,
      hasPreviousAnalysis: !!body.previousAnalysis,
    });

    const validationResult = FrameAnalysisRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid request",
          details: validationResult.error.flatten()
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { frameBase64, sessionId, previousAnalysis, patientContext } = validationResult.data;

    // Build context-aware prompt
    let contextPrompt = VISUAL_TRIAGE_SYSTEM_PROMPT;

    if (patientContext) {
      contextPrompt += `\n\nPATIENT CONTEXT:`;
      if (patientContext.name) {
        contextPrompt += `\n- Name: ${patientContext.name}`;
      }
      if (patientContext.age) {
        contextPrompt += `\n- Age: ${patientContext.age}`;
      }
      if (patientContext.symptoms) {
        contextPrompt += `\n- Reported Symptoms: ${patientContext.symptoms}`;
      }
      if (patientContext.medicalHistory) {
        contextPrompt += `\n- Medical History: ${JSON.stringify(patientContext.medicalHistory)}`;
      }
    }

    if (previousAnalysis) {
      contextPrompt += `\n\nPREVIOUS OBSERVATION (for continuity):
- Distress: ${previousAnalysis.distress}
- Breathing: ${previousAnalysis.breathing}
- Urgency: ${previousAnalysis.urgency}
Note: Focus on any changes from the previous observation.`;
    }

    // Create Gemini model instance
    const model = google("gemini-2.0-flash-001");

    console.log("🤖 [API] Calling Gemini 2.0 Flash for visual analysis...");

    // Stream structured object response
    // @ts-expect-error - Type instantiation depth issue with Zod + AI SDK
    const result = streamObject({
      model,
      schema: VisualAnalysisSchema,
      system: contextPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this patient video frame for visual medical triage. Session ID: ${sessionId}. Provide structured observations following the schema.`,
            },
            {
              type: "image",
              image: `data:image/jpeg;base64,${frameBase64}`,
            },
          ],
        },
      ],
      temperature: 0.3, // Lower temperature for more consistent medical observations
      maxTokens: 500,
    });

    console.log("✅ [API] Gemini request initiated, streaming response...");

    // Return streaming response
    return result.toTextStreamResponse();

  } catch (error) {
    console.error("Frame analysis error:", error);

    // Handle specific error types
    if (error instanceof Error) {
      if (error.message.includes("API key")) {
        return new Response(
          JSON.stringify({ error: "AI service authentication failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (error.message.includes("rate limit")) {
        return new Response(
          JSON.stringify({ error: "Too many requests. Please wait a moment." }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: "Failed to analyze frame" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Health check endpoint
export async function GET() {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "video-triage-analysis",
      configured: !!GEMINI_API_KEY
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
