"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { vapi } from "@/lib/vapi.sdk";
import type { UrgencyLevel, VapiOrchestrationState } from "@/lib/schemas/video-triage";

interface Message {
  role: "assistant" | "user";
  content: string;
  source?: "vapi" | "visual-triage";
  timestamp?: number;
}

interface UseVapiOrchestrationOptions {
  debounceMs?: number;
  minSpeakInterval?: number;
  maxQueueSize?: number;
  onMessageSpoken?: (message: string) => void;
  onError?: (error: string) => void;
}

interface UseVapiOrchestrationReturn {
  // State
  state: VapiOrchestrationState;
  isSpeaking: boolean;
  messages: Message[];

  // Actions
  queueMessage: (message: string, urgency: UrgencyLevel) => void;
  speakImmediate: (message: string) => void;
  clearQueue: () => void;
  addTranscriptMessage: (message: Message) => void;

  // Visual triage specific
  speakVisualInsight: (insight: string, urgency: UrgencyLevel) => void;
}

export function useVapiOrchestration(
  options: UseVapiOrchestrationOptions = {}
): UseVapiOrchestrationReturn {
  const {
    debounceMs = 5000, // 5 second debounce
    minSpeakInterval = 8000, // Minimum 8 seconds between spoken messages
    maxQueueSize = 5,
    onMessageSpoken,
    onError,
  } = options;

  // State
  const [state, setState] = useState<VapiOrchestrationState>({
    lastSpokenUrgency: null,
    lastSpokenAt: null,
    pendingMessage: null,
    speakDebounceMs: debounceMs,
  });

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  // Refs
  const messageQueueRef = useRef<Array<{ message: string; urgency: UrgencyLevel }>>([]);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSpokenMessagesRef = useRef<Set<string>>(new Set());
  const lastSpeakTimeRef = useRef<number>(0);

  // Listen to Vapi speech events
  useEffect(() => {
    const onSpeechStart = () => setIsSpeaking(true);
    const onSpeechEnd = () => setIsSpeaking(false);

    const onMessage = (message: any) => {
      if (message.type === "transcript" && message.transcriptType === "final") {
        const newMessage: Message = {
          role: message.role,
          content: message.transcript,
          source: "vapi",
          timestamp: Date.now(),
        };
        setMessages((prev) => [newMessage, ...prev]);
      }
    };

    vapi.on("speech-start", onSpeechStart);
    vapi.on("speech-end", onSpeechEnd);
    vapi.on("message", onMessage);

    return () => {
      vapi.off("speech-start", onSpeechStart);
      vapi.off("speech-end", onSpeechEnd);
      vapi.off("message", onMessage);
    };
  }, []);

  // Check if message is duplicate or too similar
  const isDuplicateMessage = useCallback((message: string): boolean => {
    const normalized = message.toLowerCase().trim();

    // Check exact duplicates
    if (lastSpokenMessagesRef.current.has(normalized)) {
      return true;
    }

    // Check for similar messages (simple word overlap check)
    const words = new Set(normalized.split(/\s+/).filter((w) => w.length > 3));
    for (const prevMessage of lastSpokenMessagesRef.current) {
      const prevWords = new Set(prevMessage.split(/\s+/).filter((w) => w.length > 3));
      const overlap = [...words].filter((w) => prevWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, prevWords.size);

      if (similarity > 0.7) {
        return true; // 70% word overlap = duplicate
      }
    }

    return false;
  }, []);

  // Add message to spoken history
  const recordSpokenMessage = useCallback((message: string) => {
    const normalized = message.toLowerCase().trim();
    lastSpokenMessagesRef.current.add(normalized);

    // Keep only last 10 messages in history
    if (lastSpokenMessagesRef.current.size > 10) {
      const oldest = lastSpokenMessagesRef.current.values().next().value;
      lastSpokenMessagesRef.current.delete(oldest);
    }
  }, []);

  // Process the message queue
  const processQueue = useCallback(() => {
    const now = Date.now();
    const timeSinceLastSpeak = now - lastSpeakTimeRef.current;

    // Check if we can speak (respect minimum interval)
    if (timeSinceLastSpeak < minSpeakInterval && lastSpeakTimeRef.current > 0) {
      // Schedule retry
      const delay = minSpeakInterval - timeSinceLastSpeak + 100;
      debounceTimerRef.current = setTimeout(processQueue, delay);
      return;
    }

    // Get next message from queue
    const nextItem = messageQueueRef.current.shift();
    if (!nextItem) {
      return;
    }

    // Check for duplicates
    if (isDuplicateMessage(nextItem.message)) {
      // Skip duplicate and process next
      processQueue();
      return;
    }

    // Speak the message by sending it to Vapi
    try {
      console.log("🔊 Attempting to send visual insight to Vapi:", nextItem.message);
      console.log("   Urgency:", nextItem.urgency);

      // Use Vapi's say method or send a system message
      // Note: This depends on Vapi's API - we'll inject the message into the conversation
      vapi.send({
        type: "add-message",
        message: {
          role: "system",
          content: `VISUAL OBSERVATION: ${nextItem.message}. Acknowledge this observation in your response to the patient.`,
        },
      });

      console.log("✅ Visual insight sent to Vapi successfully");

      // Record the spoken message
      recordSpokenMessage(nextItem.message);
      lastSpeakTimeRef.current = now;

      // Update state
      setState((prev) => ({
        ...prev,
        lastSpokenAt: now,
        lastSpokenUrgency: nextItem.urgency,
        pendingMessage: null,
      }));

      // Add to transcript
      const transcriptMessage: Message = {
        role: "assistant",
        content: `[Visual Analysis] ${nextItem.message}`,
        source: "visual-triage",
        timestamp: now,
      };
      setMessages((prev) => [transcriptMessage, ...prev]);

      onMessageSpoken?.(nextItem.message);

      console.log("📝 Visual insight added to transcript");

      // Continue processing queue
      if (messageQueueRef.current.length > 0) {
        debounceTimerRef.current = setTimeout(processQueue, minSpeakInterval);
      }
    } catch (error) {
      console.error("❌ Failed to send visual insight to Vapi:", error);
      onError?.(error instanceof Error ? error.message : "Failed to speak message");
    }
  }, [minSpeakInterval, isDuplicateMessage, recordSpokenMessage, onMessageSpoken, onError]);

  // Queue a message to be spoken
  const queueMessage = useCallback(
    (message: string, urgency: UrgencyLevel) => {
      // Don't queue low urgency messages if queue is full
      if (
        urgency === "low" &&
        messageQueueRef.current.length >= maxQueueSize
      ) {
        return;
      }

      // High urgency messages go to front of queue
      if (urgency === "high") {
        messageQueueRef.current.unshift({ message, urgency });
      } else {
        messageQueueRef.current.push({ message, urgency });
      }

      // Trim queue if too large
      while (messageQueueRef.current.length > maxQueueSize) {
        // Remove lowest urgency from end
        messageQueueRef.current.pop();
      }

      setState((prev) => ({
        ...prev,
        pendingMessage: message,
      }));

      // Start processing if not already
      if (!debounceTimerRef.current) {
        processQueue();
      }
    },
    [maxQueueSize, processQueue]
  );

  // Speak a message immediately (for high urgency)
  const speakImmediate = useCallback(
    (message: string) => {
      // Clear pending debounce
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Add to front of queue
      messageQueueRef.current.unshift({ message, urgency: "high" });

      // Reset last speak time to allow immediate speaking
      lastSpeakTimeRef.current = 0;

      // Process immediately
      processQueue();
    },
    [processQueue]
  );

  // Clear the message queue
  const clearQueue = useCallback(() => {
    messageQueueRef.current = [];

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      pendingMessage: null,
    }));
  }, []);

  // Add a message to transcript (without speaking)
  const addTranscriptMessage = useCallback((message: Message) => {
    setMessages((prev) => [message, ...prev]);
  }, []);

  // Speak visual triage insight
  const speakVisualInsight = useCallback(
    (insight: string, urgency: UrgencyLevel) => {
      // Format the message for natural speech
      const formattedInsight = formatForSpeech(insight);

      // High urgency gets immediate attention
      if (urgency === "high") {
        speakImmediate(formattedInsight);
      } else if (urgency === "medium") {
        queueMessage(formattedInsight, urgency);
      } else {
        // Low urgency - only queue if queue is empty
        if (messageQueueRef.current.length === 0) {
          queueMessage(formattedInsight, urgency);
        }
      }
    },
    [speakImmediate, queueMessage]
  );

  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    state,
    isSpeaking,
    messages,
    queueMessage,
    speakImmediate,
    clearQueue,
    addTranscriptMessage,
    speakVisualInsight,
  };
}

// Helper to format insights for natural speech
function formatForSpeech(text: string): string {
  // Remove technical jargon and make more conversational
  let formatted = text;

  // Ensure it doesn't start with technical prefixes
  formatted = formatted.replace(/^(visible signs suggest|the patient appears)/i, "I notice");

  // Remove any JSON-like artifacts
  formatted = formatted.replace(/[{}\[\]"]/g, "");

  // Clean up spacing
  formatted = formatted.replace(/\s+/g, " ").trim();

  // Ensure proper sentence ending
  if (!/[.!?]$/.test(formatted)) {
    formatted += ".";
  }

  return formatted;
}

export default useVapiOrchestration;
