"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type {
  VisualAnalysis,
  TriageSession,
  UrgencyLevel,
  SymptomCard,
} from "@/lib/schemas/video-triage";

interface PatientContext {
  name?: string;
  age?: number;
  symptoms?: string;
  medicalHistory?: Record<string, unknown>;
}

interface UseTriageAnalysisOptions {
  sessionId?: string;
  patientContext?: PatientContext;
  onAnalysisComplete?: (analysis: VisualAnalysis) => void;
  onUrgencyChange?: (oldUrgency: UrgencyLevel | null, newUrgency: UrgencyLevel) => void;
  onSpeakableInsight?: (message: string, urgency: UrgencyLevel) => void;
  onError?: (error: string) => void;
}

interface UseTriageAnalysisReturn {
  // Session state
  session: TriageSession | null;
  isAnalyzing: boolean;
  currentAnalysis: VisualAnalysis | null;
  analysisHistory: VisualAnalysis[];
  symptomCards: SymptomCard[];

  // Actions
  analyzeFrame: (frameBase64: string) => Promise<VisualAnalysis | null>;
  startSession: () => void;
  endSession: () => void;
  clearHistory: () => void;

  // Status
  error: string | null;
  analysisCount: number;
}

// Generate unique ID
const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export function useTriageAnalysis(options: UseTriageAnalysisOptions = {}): UseTriageAnalysisReturn {
  const {
    sessionId: providedSessionId,
    patientContext,
    onAnalysisComplete,
    onUrgencyChange,
    onSpeakableInsight,
    onError,
  } = options;

  // State
  const [session, setSession] = useState<TriageSession | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentAnalysis, setCurrentAnalysis] = useState<VisualAnalysis | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<VisualAnalysis[]>([]);
  const [symptomCards, setSymptomCards] = useState<SymptomCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastUrgencyRef = useRef<UrgencyLevel | null>(null);
  const analysisCountRef = useRef(0);

  // Start a new triage session
  const startSession = useCallback(() => {
    const newSession: TriageSession = {
      sessionId: providedSessionId || generateId(),
      startedAt: Date.now(),
      analysisHistory: [],
      currentUrgency: "low",
      spokenMessages: [],
      isActive: true,
    };

    setSession(newSession);
    setAnalysisHistory([]);
    setSymptomCards([]);
    setCurrentAnalysis(null);
    setError(null);
    lastUrgencyRef.current = null;
    analysisCountRef.current = 0;
  }, [providedSessionId]);

  // End the current session
  const endSession = useCallback(() => {
    // Abort any in-flight analysis
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setSession(prev => prev ? { ...prev, isActive: false } : null);
    setIsAnalyzing(false);
  }, []);

  // Clear analysis history
  const clearHistory = useCallback(() => {
    setAnalysisHistory([]);
    setSymptomCards([]);
    setCurrentAnalysis(null);
    analysisCountRef.current = 0;
    lastUrgencyRef.current = null;
  }, []);

  // Convert analysis to symptom cards
  const createSymptomCards = useCallback((analysis: VisualAnalysis): SymptomCard[] => {
    const timestamp = Date.now();
    const cards: SymptomCard[] = [];

    if (analysis.distress && analysis.distress !== "normal" && analysis.distress !== "not visible") {
      cards.push({
        id: generateId(),
        category: "distress",
        label: "Distress Level",
        value: analysis.distress,
        urgency: analysis.urgency,
        timestamp,
      });
    }

    if (analysis.breathing && analysis.breathing !== "normal breathing" && analysis.breathing !== "not visible") {
      cards.push({
        id: generateId(),
        category: "breathing",
        label: "Breathing Pattern",
        value: analysis.breathing,
        urgency: analysis.urgency,
        timestamp,
      });
    }

    if (analysis.posture && analysis.posture !== "normal posture" && analysis.posture !== "not visible") {
      cards.push({
        id: generateId(),
        category: "posture",
        label: "Posture",
        value: analysis.posture,
        urgency: analysis.urgency,
        timestamp,
      });
    }

    if (analysis.fatigue && analysis.fatigue !== "alert and responsive" && analysis.fatigue !== "not visible") {
      cards.push({
        id: generateId(),
        category: "fatigue",
        label: "Fatigue Signs",
        value: analysis.fatigue,
        urgency: analysis.urgency,
        timestamp,
      });
    }

    if (analysis.visibleFinding && analysis.visibleFinding !== "none" && analysis.visibleFinding !== "not visible") {
      cards.push({
        id: generateId(),
        category: "finding",
        label: "Visible Finding",
        value: analysis.visibleFinding,
        urgency: analysis.urgency,
        timestamp,
      });
    }

    return cards;
  }, []);

  // Parse streaming JSON response
  const parseStreamedObject = (text: string): Partial<VisualAnalysis> | null => {
    try {
      // The Vercel AI SDK streams JSON, try to parse what we have
      const trimmed = text.trim();
      if (!trimmed) return null;

      // Try to parse as complete JSON first
      try {
        return JSON.parse(trimmed);
      } catch {
        // Try to extract partial JSON for streaming updates
        // This handles the case where we get partial JSON during streaming
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            return JSON.parse(match[0]);
          } catch {
            return null;
          }
        }
        return null;
      }
    } catch {
      return null;
    }
  };

  // Analyze a single frame
  const analyzeFrame = useCallback(async (frameBase64: string): Promise<VisualAnalysis | null> => {
    if (!session?.isActive) {
      console.warn("⚠️ No active session. Call startSession() first.");
      return null;
    }

    if (isAnalyzing) {
      console.warn("⚠️ Analysis already in progress, skipping frame");
      return null;
    }

    console.log("🔬 Starting frame analysis...");
    console.log("   Session ID:", session.sessionId);
    console.log("   Frame size:", frameBase64.length, "bytes");
    console.log("   Patient context:", patientContext);

    setIsAnalyzing(true);
    setError(null);

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      console.log("📡 Sending frame to Gemini API...");
      const response = await fetch("/api/triage/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frameBase64,
          sessionId: session.sessionId,
          previousAnalysis: currentAnalysis,
          patientContext,
        }),
        signal: abortControllerRef.current.signal,
      });

      console.log("📡 API Response status:", response.status, response.statusText);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Analysis failed: ${response.status}`);
      }

      // Read streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let fullText = "";
      let finalAnalysis: VisualAnalysis | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        // Try to parse partial response for real-time updates
        const partial = parseStreamedObject(fullText);
        if (partial && partial.shortReply) {
          // We have enough data for a partial update
          setCurrentAnalysis(prev => ({
            distress: partial.distress || prev?.distress || "",
            breathing: partial.breathing || prev?.breathing || "",
            posture: partial.posture || prev?.posture || "",
            fatigue: partial.fatigue || prev?.fatigue || "",
            visibleFinding: partial.visibleFinding || prev?.visibleFinding || "",
            urgency: partial.urgency || prev?.urgency || "low",
            shortReply: partial.shortReply || prev?.shortReply || "",
          }));
        }
      }

      // Parse final response
      finalAnalysis = parseStreamedObject(fullText) as VisualAnalysis;

      console.log("📊 Gemini Analysis Complete:", finalAnalysis);

      if (!finalAnalysis || !finalAnalysis.urgency) {
        throw new Error("Invalid analysis response");
      }

      // Update state with final analysis
      setCurrentAnalysis(finalAnalysis);
      setAnalysisHistory(prev => [...prev, finalAnalysis!]);

      console.log("✅ Analysis saved to state");

      // Create and update symptom cards
      const newCards = createSymptomCards(finalAnalysis);
      console.log("🏥 Created symptom cards:", newCards.length);
      setSymptomCards(prev => {
        // Keep last 10 unique cards
        const combined = [...newCards, ...prev];
        const unique = combined.filter((card, index, self) =>
          index === self.findIndex(c => c.category === card.category && c.value === card.value)
        );
        return unique.slice(0, 10);
      });

      // Update session
      setSession(prev => prev ? {
        ...prev,
        analysisHistory: [...prev.analysisHistory, finalAnalysis!],
        currentUrgency: finalAnalysis!.urgency,
      } : null);

      analysisCountRef.current++;
      console.log("📈 Total analyses:", analysisCountRef.current);

      // Check for urgency change
      const urgencyChanged = lastUrgencyRef.current !== finalAnalysis.urgency;
      console.log("🚨 Urgency check:", {
        previous: lastUrgencyRef.current,
        current: finalAnalysis.urgency,
        changed: urgencyChanged,
      });

      if (urgencyChanged) {
        onUrgencyChange?.(lastUrgencyRef.current, finalAnalysis.urgency);

        // Determine if we should speak this insight
        const shouldSpeak = shouldSpeakInsight(lastUrgencyRef.current, finalAnalysis.urgency, finalAnalysis);
        console.log("🗣️ Should speak insight:", shouldSpeak);
        console.log("   Short reply:", finalAnalysis.shortReply);

        if (shouldSpeak) {
          console.log("📢 Calling onSpeakableInsight with:", finalAnalysis.shortReply);
          onSpeakableInsight?.(finalAnalysis.shortReply, finalAnalysis.urgency);
        } else {
          console.log("🔇 Not speaking - conditions not met");
        }

        lastUrgencyRef.current = finalAnalysis.urgency;
      } else {
        console.log("🔇 Urgency unchanged - not speaking");
      }

      onAnalysisComplete?.(finalAnalysis);

      return finalAnalysis;

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Request was aborted, not an error
        return null;
      }

      const errorMessage = err instanceof Error ? err.message : "Analysis failed";
      setError(errorMessage);
      onError?.(errorMessage);
      return null;

    } finally {
      setIsAnalyzing(false);
      abortControllerRef.current = null;
    }
  }, [
    session,
    isAnalyzing,
    currentAnalysis,
    patientContext,
    createSymptomCards,
    onAnalysisComplete,
    onUrgencyChange,
    onSpeakableInsight,
    onError,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    session,
    isAnalyzing,
    currentAnalysis,
    analysisHistory,
    symptomCards,
    analyzeFrame,
    startSession,
    endSession,
    clearHistory,
    error,
    analysisCount: analysisCountRef.current,
  };
}

// Determine if insight should be spoken aloud
function shouldSpeakInsight(
  previousUrgency: UrgencyLevel | null,
  currentUrgency: UrgencyLevel,
  analysis: VisualAnalysis
): boolean {
  // ALWAYS speak the first analysis (when previousUrgency is null)
  if (previousUrgency === null) {
    console.log("   → First analysis, will speak");
    return true;
  }

  // Always speak on urgency escalation
  if (previousUrgency) {
    const urgencyOrder: UrgencyLevel[] = ["low", "medium", "high"];
    const prevIndex = urgencyOrder.indexOf(previousUrgency);
    const currIndex = urgencyOrder.indexOf(currentUrgency);

    if (currIndex > prevIndex) {
      console.log("   → Urgency escalated, will speak");
      return true; // Escalation
    }
  }

  // Speak high urgency findings
  if (currentUrgency === "high") {
    console.log("   → High urgency, will speak");
    return true;
  }

  // For medium urgency, speak if there's a meaningful finding
  if (currentUrgency === "medium" && analysis.visibleFinding && analysis.visibleFinding !== "none" && analysis.visibleFinding !== "not visible") {
    console.log("   → Medium urgency with finding, will speak");
    return true;
  }

  // Don't speak low-signal observations
  console.log("   → Conditions not met, will not speak");
  return false;
}

export default useTriageAnalysis;
