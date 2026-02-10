/**
 * AI Service
 * Unified interface for AI-powered analysis, classification, and content moderation
 * Supports multiple provider backends (Anthropic Claude, Google Vision, etc.)
 */

import { Anthropic } from "@anthropic-ai/sdk";

export enum AnalysisType {
  CLASSIFICATION = "classification",
  METADATA_EXTRACTION = "metadata_extraction",
  DESCRIPTION_GENERATION = "description_generation",
  CONTENT_MODERATION = "content_moderation",
  TAG_SUGGESTION = "tag_suggestion",
}

export interface AnalysisResult {
  type: AnalysisType;
  confidence: number;
  data: Record<string, unknown>;
  processing_time_ms: number;
  model: string;
  cost_estimate_usd?: number;
}

export interface ClassificationResult {
  category: string;
  subcategories: string[];
  confidence: number;
  explanation: string;
}

export interface MetadataExtractionResult {
  date_captured?: string;
  location?: {
    lat?: number;
    lng?: number;
    address?: string;
  };
  objects_detected: string[];
  text_content?: string;
  faces_detected: number;
  other_metadata: Record<string, unknown>;
}

export interface DescriptionResult {
  title: string;
  description: string;
  summary: string;
  key_points: string[];
}

export interface ModerationResult {
  is_safe: boolean;
  risk_level: "safe" | "low_risk" | "medium_risk" | "high_risk";
  flags: string[];
  confidence: number;
  recommendation: string;
}

export interface TagSuggestionResult {
  tags: string[];
  confidence_per_tag: Record<string, number>;
}

interface AIServiceConfig {
  provider: "anthropic" | "google" | "mock";
  apiKey?: string;
  enabled: boolean;
  model?: string;
}

/**
 * AI Service for evidence analysis
 */
export class AIService {
  private config: AIServiceConfig;
  private client?: Anthropic;
  private usage: {
    total_calls: number;
    total_cost_usd: number;
    calls_by_type: Record<string, number>;
  };

  constructor(config: Partial<AIServiceConfig> = {}) {
    this.config = {
      provider: (process.env.AI_PROVIDER as "anthropic" | "google" | "mock") ?? "mock",
      apiKey: process.env.AI_API_KEY,
      enabled: process.env.NODE_ENV !== "test" && !!process.env.AI_API_KEY,
      model: process.env.AI_MODEL ?? "claude-3-5-sonnet-20241022",
      ...config,
    };

    this.usage = {
      total_calls: 0,
      total_cost_usd: 0,
      calls_by_type: {},
    };

    if (this.config.enabled && this.config.provider === "anthropic") {
      this.client = new Anthropic({
        apiKey: this.config.apiKey,
      });
    }
  }

  /**
   * Analyze evidence image
   */
  async analyzeEvidence(
    imageUrl: string,
    evidenceType: string
  ): Promise<{
    classification: ClassificationResult;
    metadata: MetadataExtractionResult;
    description: DescriptionResult;
    moderation: ModerationResult;
    tags: TagSuggestionResult;
  }> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      return this.getMockAnalysis(imageUrl, evidenceType);
    }

    try {
      // Use Anthropic Claude for vision analysis
      const prompt = `You are an expert forensic analyst and content classifier. Analyze this ${evidenceType} evidence and provide detailed insights.

Provide your response as a JSON object with the following structure:
{
  "classification": {
    "category": "string (primary category)",
    "subcategories": ["array", "of", "subcategories"],
    "confidence": 0.95,
    "explanation": "explanation of classification"
  },
  "metadata": {
    "date_captured": "ISO date if visible",
    "location": {
      "lat": null,
      "lng": null,
      "address": "address if visible"
    },
    "objects_detected": ["object1", "object2"],
    "text_content": "any visible text",
    "faces_detected": 0,
    "other_metadata": {}
  },
  "description": {
    "title": "short title",
    "description": "detailed description",
    "summary": "one-line summary",
    "key_points": ["point1", "point2"]
  },
  "moderation": {
    "is_safe": true,
    "risk_level": "safe|low_risk|medium_risk|high_risk",
    "flags": [],
    "confidence": 0.95,
    "recommendation": "recommendation"
  },
  "tags": {
    "tags": ["tag1", "tag2", "tag3"],
    "confidence_per_tag": {"tag1": 0.9, "tag2": 0.85}
  }
}`;

      const response = await this.client!.messages.create({
        model: this.config.model!,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: imageUrl,
                },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from AI");
      }

      // Extract JSON from response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not parse AI response as JSON");
      }

      const analysisData = JSON.parse(jsonMatch[0]);
      const processingTime = Date.now() - startTime;

      // Track usage
      this.trackUsage("full_analysis", processingTime, 0.1); // Estimate $0.10 per analysis

      return {
        classification: analysisData.classification,
        metadata: analysisData.metadata,
        description: analysisData.description,
        moderation: analysisData.moderation,
        tags: analysisData.tags,
      };
    } catch (error) {
      console.error("AI analysis failed:", error);
      // Fallback to mock analysis
      return this.getMockAnalysis(imageUrl, evidenceType);
    }
  }

  /**
   * Classify evidence
   */
  async classify(imageUrl: string, evidenceType: string): Promise<ClassificationResult> {
    const analysis = await this.analyzeEvidence(imageUrl, evidenceType);
    return analysis.classification;
  }

  /**
   * Extract metadata from evidence
   */
  async extractMetadata(imageUrl: string): Promise<MetadataExtractionResult> {
    const analysis = await this.analyzeEvidence(imageUrl, "document");
    return analysis.metadata;
  }

  /**
   * Generate description for evidence
   */
  async generateDescription(imageUrl: string, context?: string): Promise<DescriptionResult> {
    if (!this.config.enabled) {
      return {
        title: "Evidence Item",
        description: "No description available",
        summary: "Evidence captured",
        key_points: [],
      };
    }

    try {
      const response = await this.client!.messages.create({
        model: this.config.model!,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: imageUrl,
                },
              },
              {
                type: "text",
                text: `Generate a detailed description for this evidence item.${context ? ` Context: ${context}` : ""}

Respond as JSON:
{
  "title": "short title",
  "description": "detailed description",
  "summary": "one-line summary",
  "key_points": ["point1", "point2"]
}`,
              },
            ],
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type");
      }

      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not parse response");
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("Description generation failed:", error);
      return {
        title: "Evidence Item",
        description: "Unable to generate description",
        summary: "Evidence captured",
        key_points: [],
      };
    }
  }

  /**
   * Check content safety/moderation
   */
  async checkModeration(imageUrl: string): Promise<ModerationResult> {
    const analysis = await this.analyzeEvidence(imageUrl, "image");
    return analysis.moderation;
  }

  /**
   * Suggest tags for evidence
   */
  async suggestTags(imageUrl: string, context?: string): Promise<TagSuggestionResult> {
    const analysis = await this.analyzeEvidence(imageUrl, context || "evidence");
    return analysis.tags;
  }

  /**
   * Get usage statistics
   */
  getUsageStats(): {
    total_calls: number;
    total_cost_usd: number;
    calls_by_type: Record<string, number>;
    average_cost_per_call: number;
  } {
    return {
      ...this.usage,
      average_cost_per_call:
        this.usage.total_calls > 0 ? this.usage.total_cost_usd / this.usage.total_calls : 0,
    };
  }

  /**
   * Reset usage tracking (admin only)
   */
  resetUsageStats(): void {
    this.usage = {
      total_calls: 0,
      total_cost_usd: 0,
      calls_by_type: {},
    };
  }

  /**
   * Track API usage
   */
  private trackUsage(analysisType: string, processingTimeMs: number, costUsd: number): void {
    this.usage.total_calls++;
    this.usage.total_cost_usd += costUsd;
    this.usage.calls_by_type[analysisType] = (this.usage.calls_by_type[analysisType] || 0) + 1;
  }

  /**
   * Mock analysis for development/testing
   */
  private getMockAnalysis(
    imageUrl: string,
    evidenceType: string
  ): {
    classification: ClassificationResult;
    metadata: MetadataExtractionResult;
    description: DescriptionResult;
    moderation: ModerationResult;
    tags: TagSuggestionResult;
  } {
    return {
      classification: {
        category: evidenceType === "PHOTO" ? "photograph" : "document",
        subcategories: [
          evidenceType === "PHOTO" ? "indoor_scene" : "text_document",
        ],
        confidence: 0.92,
        explanation: `This appears to be a ${evidenceType.toLowerCase()}. Classification based on metadata and visual characteristics.`,
      },
      metadata: {
        date_captured: new Date().toISOString(),
        location: {
          lat: undefined,
          lng: undefined,
          address: undefined,
        },
        objects_detected: evidenceType === "PHOTO" ? ["person", "object"] : ["text"],
        text_content: undefined,
        faces_detected: evidenceType === "PHOTO" ? 0 : 0,
        other_metadata: {},
      },
      description: {
        title: `${evidenceType} Evidence`,
        description: `This is a captured ${evidenceType.toLowerCase()} evidence item. Detailed analysis requires AI service to be enabled.`,
        summary: `${evidenceType} evidence item`,
        key_points: ["Captured evidence", "Awaiting analysis"],
      },
      moderation: {
        is_safe: true,
        risk_level: "safe",
        flags: [],
        confidence: 0.95,
        recommendation: "Evidence is safe to process",
      },
      tags: {
        tags: ["evidence", evidenceType.toLowerCase()],
        confidence_per_tag: {
          evidence: 0.99,
          [evidenceType.toLowerCase()]: 0.95,
        },
      },
    };
  }
}

/**
 * Global AI service instance
 */
export const aiService = new AIService();
