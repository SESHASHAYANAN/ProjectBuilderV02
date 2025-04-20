import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import io from "socket.io-client";
import "./styles.css";
const AI_MODELS = {
  LLAMA: "llama3-70b-8192", 
  CLAUDE: "llama3-70b-8192", 
  GPT4: "gpt-4o-2024-05-13", 
};

const AGENT_SPECIALIZATIONS = {
  CODER: "code-generation",
  DESIGNER: "ui-design",
  ARCHITECT: "system-architecture",
  DEBUGGER: "code-debugging",
  DOCUMENTER: "documentation",
  TESTER: "test-generation",
  SECURITY: "security-analysis",
  OPTIMIZER: "performance-optimization",
};





const BACKEND_CONFIG = {
  BASE_URL: process.env.REACT_APP_BACKEND_URL || "http://localhost:5000",
  WS_URL: process.env.REACT_APP_WS_URL || "ws://localhost:5000",
  API_VERSION: "v1",
};

class ModelPerformanceTracker {
  constructor() {
    this.metrics = Object.keys(AI_MODELS).reduce((acc, modelKey) => {
      acc[AI_MODELS[modelKey]] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatency: 0,
        averageLatency: 0,
        totalTokens: 0,
      };
      return acc;
    }, {});
  }

  recordModelCall(model, outcome, latency, tokens) {
    if (!this.metrics[model]) {
      this.metrics[model] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatency: 0,
        averageLatency: 0,
        totalTokens: 0,
      };
    }

    this.metrics[model].calls += 1;

    if (outcome === "success") {
      this.metrics[model].successes += 1;
    } else {
      this.metrics[model].failures += 1;
    }

    if (latency) {
      this.metrics[model].totalLatency += latency;
      this.metrics[model].averageLatency =
        this.metrics[model].totalLatency / this.metrics[model].calls;
    }

    if (tokens) {
      this.metrics[model].totalTokens += tokens;
    }
  }

  getModelMetrics(model) {
    return this.metrics[model] || null;
  }

  getOptimalModelForTask(taskType) {
    const modelEntries = Object.entries(this.metrics);
    if (modelEntries.length === 0) return AI_MODELS.LLAMA;

    const modelsWithData = modelEntries.filter(([_, data]) => data.calls > 5);
    if (modelsWithData.length === 0) return AI_MODELS.LLAMA;

    return modelsWithData.sort(([_, dataA], [__, dataB]) => {
      const successRateA = dataA.successes / dataA.calls;
      const successRateB = dataB.successes / dataB.calls;
      return successRateB - successRateA;
    })[0][0];
  }
}

const modelTracker = new ModelPerformanceTracker();

const selectOptimalModel = (taskContext) => {
  const { taskType = "", fileType = "", prompt = "" } = taskContext;

  if (
    fileType === "css" ||
    fileType === "scss" ||
    prompt.toLowerCase().includes("design") ||
    prompt.toLowerCase().includes("ui") ||
    prompt.toLowerCase().includes("layout") ||
    prompt.toLowerCase().includes("style")
  ) {
    return AI_MODELS.CLAUDE;
  }

  if (
    prompt.toLowerCase().includes("architecture") ||
    prompt.toLowerCase().includes("system design") ||
    prompt.toLowerCase().includes("security")
  ) {
    return AI_MODELS.GPT4;
  }

  return AI_MODELS.LLAMA;
};

class BackendService {
  constructor() {
    this.baseUrl = BACKEND_CONFIG.BASE_URL;
    this.apiVersion = BACKEND_CONFIG.API_VERSION;
    this.socket = null;
    this.eventListeners = new Map();
    this.isConnected = false;
    this.connectionPromise = null;
  }

  async initialize() {
    if (!this.connectionPromise) {
      this.connectionPromise = new Promise((resolve, reject) => {
        try {
          this.socket = io(BACKEND_CONFIG.WS_URL, {
            reconnectionDelay: 1000,
            reconnection: true,
            reconnectionAttempts: 10,
            transports: ["websocket"],
            upgrade: false,
          });

          this.socket.on("connect", () => {
            console.log("WebSocket connected");
            this.isConnected = true;
            resolve(true);
          });

          this.socket.on("connect_error", (error) => {
            console.error("WebSocket connection error:", error);
            if (!this.isConnected) {
              reject(error);
            }
          });

          this.socket.on("disconnect", (reason) => {
            console.log("WebSocket disconnected:", reason);
            this.isConnected = false;
          });

          this.socket.on("error", this.handleSocketError.bind(this));
          this.socket.on("notification", this.handleNotification.bind(this));
        } catch (error) {
          console.error("Failed to initialize backend connection:", error);
          reject(error);
        }
      });
    }

    return this.connectionPromise;
  }

  async apiCall(endpoint, method = "GET", data = null, options = {}) {
    const {
      version = this.apiVersion,
      timeout = 30000,
      headers = {},
    } = options;

    const url = `${this.baseUrl}/api/${version}/${endpoint}`;

    const fetchOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    if (method !== "GET" && data) {
      fetchOptions.body = JSON.stringify(data);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      fetchOptions.signal = controller.signal;

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `API call failed: ${response.status} ${response.statusText}`
        );
      }

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      } else {
        return { success: true, status: response.status };
      }
    } catch (error) {
      console.error(`API call to ${endpoint} failed:`, error);
      throw error;
    }
  }

  subscribe(eventName, callback) {
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, new Set());

      if (this.isConnected && this.socket) {
        this.socket.on(eventName, (data) => {
          this.notifyEventListeners(eventName, data);
        });
      }
    }

    this.eventListeners.get(eventName).add(callback);

    return () => {
      if (this.eventListeners.has(eventName)) {
        this.eventListeners.get(eventName).delete(callback);
      }
    };
  }

  notifyEventListeners(eventName, data) {
    if (this.eventListeners.has(eventName)) {
      this.eventListeners.get(eventName).forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for ${eventName}:`, error);
        }
      });
    }
  }

  handleSocketError(error) {
    console.error("WebSocket error:", error);
    this.notifyEventListeners("error", error);
  }

  handleNotification(notification) {
    this.notifyEventListeners("notification", notification);
  }
}

const backendService = new BackendService();

class PexelsMediaService {
  constructor() {
    this.apiKey = PEXELS_API_KEY;
    this.cache = new Map();
    this.processingQueue = [];
    this.activeRequests = 0;
    this.MAX_CONCURRENT_REQUESTS = 3;
  }

  async searchImages(query, options = {}) {
    const { perPage = 12, page = 1, withAnalysis = false } = options;

    const cacheKey = `images:${query}:${perPage}:${page}`;

    const cachedResult = this.getCachedResult(cacheKey);
    if (cachedResult) {
      return withAnalysis
        ? await this.enhanceWithAnalysis(cachedResult)
        : cachedResult;
    }

    if (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
      return new Promise((resolve, reject) => {
        this.processingQueue.push({
          action: "searchImages",
          params: { query, options },
          resolve,
          reject,
        });
      });
    }

    this.activeRequests++;

    try {
      const response = await axios.get("https://api.pexels.com/v1/search", {
        params: {
          query,
          per_page: perPage,
          page,
        },
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
      });

      const normalizedResults = this.normalizeImageResults(response.data);

      this.cacheResult(cacheKey, normalizedResults);

      if (withAnalysis) {
        return await this.enhanceWithAnalysis(normalizedResults);
      }

      return normalizedResults;
    } catch (error) {
      console.error("Pexels image search error:", error);
      throw error;
    } finally {
      this.activeRequests--;
      this.processNextFromQueue();
    }
  }

  async searchVideos(query, options = {}) {
    const { perPage = 6, page = 1, withAnalysis = false } = options;

    const cacheKey = `videos:${query}:${perPage}:${page}`;

    const cachedResult = this.getCachedResult(cacheKey);
    if (cachedResult) {
      return withAnalysis
        ? await this.enhanceWithAnalysis(cachedResult, "video")
        : cachedResult;
    }

    if (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
      return new Promise((resolve, reject) => {
        this.processingQueue.push({
          action: "searchVideos",
          params: { query, options },
          resolve,
          reject,
        });
      });
    }

    this.activeRequests++;

    try {
      const response = await axios.get("https://api.pexels.com/videos/search", {
        params: {
          query,
          per_page: perPage,
          page,
        },
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
      });

      const normalizedResults = this.normalizeVideoResults(response.data);

      this.cacheResult(cacheKey, normalizedResults);

      if (withAnalysis) {
        return await this.enhanceWithAnalysis(normalizedResults, "video");
      }

      return normalizedResults;
    } catch (error) {
      console.error("Pexels video search error:", error);
      throw error;
    } finally {
      this.activeRequests--;
      this.processNextFromQueue();
    }
  }

  async generateCodeFromImage(imageUrl, options = {}) {
    const {
      codeType = "react-component",
      includeCSS = true,
      componentName = "ImageBasedComponent",
      adaptiveLayout = true,
      theme = "light",
    } = options;

    const startTime = Date.now();

    try {
      const imageAnalysis = await backendService.apiCall(
        "ai/analyze-image",
        "POST",
        {
          imageUrl,
          analyzeLayout: true,
          analyzeColors: true,
          analyzeComponents: true,
        }
      );

      const codeGeneration = await backendService.apiCall(
        "ai/generate-code",
        "POST",
        {
          imageAnalysis,
          codeType,
          includeCSS,
          componentName,
          adaptiveLayout,
          theme,
        }
      );

      const latency = Date.now() - startTime;

      modelTracker.recordModelCall(
        AI_MODELS.CLAUDE,
        codeGeneration.success ? "success" : "failure",
        latency,
        codeGeneration.tokensUsed
      );

      return {
        code: codeGeneration.code,
        analysis: imageAnalysis,
        previewHtml: codeGeneration.previewHtml,
        componentStructure: codeGeneration.componentStructure,
        colorPalette: imageAnalysis.colors,
      };
    } catch (error) {
      console.error("Error generating code from image:", error);
      throw error;
    }
  }

  async enhanceWithAnalysis(results, mediaType = "image") {
    try {
      const analysisPromises = results.media.map(async (item) => {
        if (item.analysis) return item;

        try {
          const response = await backendService.apiCall(
            "ai/analyze-media",
            "POST",
            {
              mediaType,
              mediaUrl:
                mediaType === "image"
                  ? item.src.large
                  : item.video_files[0].link,
              mediaId: item.id,
            }
          );

          return {
            ...item,
            analysis: response.analysis || {
              description: "",
              colors: [],
              subjects: [],
              style: "",
              mood: "",
              composition: "",
              suitableFor: [],
            },
          };
        } catch (error) {
          console.error(`Error analyzing media ${item.id}:`, error);
          return item;
        }
      });

      const enhancedMedia = await Promise.all(analysisPromises);

      return {
        ...results,
        media: enhancedMedia,
      };
    } catch (error) {
      console.error("Error enhancing media with analysis:", error);
      return results;
    }
  }

  normalizeImageResults(data) {
    return {
      page: data.page || 1,
      perPage: data.per_page || 12,
      totalResults: data.total_results || 0,
      nextPage: data.next_page,
      prevPage: data.prev_page,
      media: data.photos.map((photo) => this.normalizeImageData(photo)),
    };
  }

  normalizeVideoResults(data) {
    return {
      page: data.page || 1,
      perPage: data.per_page || 6,
      totalResults: data.total_results || 0,
      nextPage: data.next_page,
      prevPage: data.prev_page,
      media: data.videos.map((video) => this.normalizeVideoData(video)),
    };
  }

  normalizeImageData(photo) {
    return {
      id: photo.id,
      width: photo.width,
      height: photo.height,
      url: photo.url,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      photographerId: photo.photographer_id,
      avgColor: photo.avg_color,
      src: photo.src,
      alt: photo.alt,
      type: "image",
      aspectRatio: photo.width / photo.height,
    };
  }

  normalizeVideoData(video) {
    return {
      id: video.id,
      width: video.width,
      height: video.height,
      url: video.url,
      image: video.image,
      duration: video.duration,
      user: video.user,
      videoFiles: video.video_files,
      videoPictures: video.video_pictures,
      type: "video",
      aspectRatio: video.width / video.height,
    };
  }

  getCachedResult(key) {
    if (this.cache.has(key)) {
      const { data, timestamp } = this.cache.get(key);
      const now = Date.now();

      // Check if cache is still valid (24 hours)
      if (now - timestamp < 24 * 60 * 60 * 1000) {
        return data;
      } else {
        // Remove expired cache
        this.cache.delete(key);
      }
    }

    return null;
  }

  cacheResult(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });

    if (this.cache.size > 100) {
      const entries = [...this.cache.entries()];
      const oldestEntries = entries
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, 20);

      oldestEntries.forEach(([key]) => this.cache.delete(key));
    }
  }

  processNextFromQueue() {
    if (
      this.processingQueue.length > 0 &&
      this.activeRequests < this.MAX_CONCURRENT_REQUESTS
    ) {
      const nextRequest = this.processingQueue.shift();

      if (nextRequest.action === "searchImages") {
        this.searchImages(nextRequest.params.query, nextRequest.params.options)
          .then(nextRequest.resolve)
          .catch(nextRequest.reject);
      } else if (nextRequest.action === "searchVideos") {
        this.searchVideos(nextRequest.params.query, nextRequest.params.options)
          .then(nextRequest.resolve)
          .catch(nextRequest.reject);
      }
    }
  }
}

const pexelsService = new PexelsMediaService();

class AgentCoordinator {
  constructor() {
    this.activeAgents = new Map();
    this.taskHistory = [];
    this.maxConcurrentAgents = 3;
    this.taskQueue = [];

    this.agentCapabilities = {
      [AGENT_SPECIALIZATIONS.CODER]: {
        description:
          "Generates clean, maintainable code in various programming languages",
        preferredModel: AI_MODELS.LLAMA,
        fallbackModel: AI_MODELS.CLAUDE,
        systemPrompt: `You are an expert software developer with deep knowledge of best practices, design patterns, and modern coding standards. Your task is to write clean, efficient, well-documented code based on the requirements provided.`,
      },
      [AGENT_SPECIALIZATIONS.DESIGNER]: {
        description: "Creates visually appealing UI components and designs",
        preferredModel: AI_MODELS.CLAUDE,
        fallbackModel: AI_MODELS.LLAMA,
        systemPrompt: `You are an expert UI/UX designer with deep knowledge of design principles, accessibility standards, and modern frontend frameworks. Your task is to create visually appealing, accessible, and responsive UI components.`,
      },
      [AGENT_SPECIALIZATIONS.ARCHITECT]: {
        description:
          "Designs robust system architectures and software structures",
        preferredModel: AI_MODELS.GPT4,
        fallbackModel: AI_MODELS.LLAMA,
        systemPrompt: `You are an expert software architect with deep knowledge of system design, architectural patterns, and enterprise best practices. Your task is to design robust, scalable system architectures.`,
      },
      [AGENT_SPECIALIZATIONS.DEBUGGER]: {
        description: "Identifies and fixes bugs and issues in code",
        preferredModel: AI_MODELS.LLAMA,
        fallbackModel: AI_MODELS.GPT4,
        systemPrompt: `You are an expert code debugger with deep knowledge of common bugs, edge cases, and debugging techniques. Your task is to identify and fix issues in the provided code.`,
      },
    };
  }

  async executeTask(task) {
    const {
      taskType,
      specialization = this.determineSpecialization(task),
      input,
      context = {},
      priority = "normal",
      callback,
    } = task;

    const structuredTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      taskType,
      specialization,
      input,
      context,
      priority,
      status: "pending",
      createdAt: new Date(),
      callback,
      result: null,
    };

    this.taskHistory.push(structuredTask);

    if (this.activeAgents.size >= this.maxConcurrentAgents) {
      return new Promise((resolve, reject) => {
        this.taskQueue.push({
          task: structuredTask,
          resolve,
          reject,
        });
      });
    }

    return this.processTask(structuredTask);
  }

  async processTask(task) {
    try {
      const agentId = this.createAgent(task.specialization);
      const agent = this.getAgent(agentId);

      task.status = "processing";
      task.agentId = agentId;
      task.startedAt = new Date();

      const result = await agent.executeTask(
        task.taskType,
        task.input,
        task.context
      );

      task.status = "completed";
      task.completedAt = new Date();
      task.result = result;

      this.activeAgents.delete(agentId);

      this.processNextTask();

      if (task.callback) {
        task.callback(null, result);
      }

      return result;
    } catch (error) {
      console.error("Task processing error:", error);

      task.status = "failed";
      task.error = error.message;
      task.completedAt = new Date();

      if (task.agentId) {
        this.activeAgents.delete(task.agentId);
      }

      this.processNextTask();

      if (task.callback) {
        task.callback(error);
      }

      throw error;
    }
  }

  processNextTask() {
    if (
      this.taskQueue.length > 0 &&
      this.activeAgents.size < this.maxConcurrentAgents
    ) {
      const nextTask = this.taskQueue.shift();

      this.processTask(nextTask.task)
        .then(nextTask.resolve)
        .catch(nextTask.reject);
    }
  }

  createAgent(specialization, customConfig = {}) {
    if (!this.agentCapabilities[specialization]) {
      throw new Error(`Unknown agent specialization: ${specialization}`);
    }

    const agentConfig = {
      ...this.agentCapabilities[specialization],
      ...customConfig,
    };

    const agentId = `${specialization}-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    const agent = new AIAgent(agentId, specialization, agentConfig);

    this.activeAgents.set(agentId, agent);

    return agentId;
  }

  getAgent(agentId) {
    return this.activeAgents.get(agentId);
  }

  determineSpecialization(task) {
    const { taskType, input = "" } = task;

    const inputLower = input.toLowerCase();

    if (
      inputLower.includes("design") ||
      inputLower.includes("ui") ||
      inputLower.includes("layout") ||
      inputLower.includes("css")
    ) {
      return AGENT_SPECIALIZATIONS.DESIGNER;
    }

    if (
      inputLower.includes("architecture") ||
      inputLower.includes("system design") ||
      inputLower.includes("structure")
    ) {
      return AGENT_SPECIALIZATIONS.ARCHITECT;
    }

    if (
      inputLower.includes("bug") ||
      inputLower.includes("fix") ||
      inputLower.includes("issue")
    ) {
      return AGENT_SPECIALIZATIONS.DEBUGGER;
    }

    return AGENT_SPECIALIZATIONS.CODER;
  }
}

class AIAgent {
  constructor(id, specialization, config) {
    this.id = id;
    this.specialization = specialization;
    this.config = config;
    this.taskHistory = [];
    this.created = new Date();
    this.lastActive = new Date();
  }

  async executeTask(taskType, input, context = {}) {
    this.lastActive = new Date();

    try {
      const taskContext = {
        taskType,
        fileType: context.fileType || "",
        complexity: context.complexity || "medium",
        prompt: input,
      };

      const preferredModel = this.config.preferredModel;
      const fallbackModel = this.config.fallbackModel;

      const model =
        modelTracker.getOptimalModelForTask(taskType) ||
        selectOptimalModel(taskContext) ||
        preferredModel;

      const startTime = Date.now();

      console.log(
        `Agent ${this.id} (${this.specialization}) executing ${taskType} with model ${model}`
      );

      const messages = [
        {
          role: "system",
          content: this.config.systemPrompt,
        },
        {
          role: "user",
          content: this.preparePrompt(taskType, input, context),
        },
      ];

      if (context.chatHistory && Array.isArray(context.chatHistory)) {
        messages.splice(
          1,
          0,
          ...context.chatHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          }))
        );
      }

      try {
        const response = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model,
            messages,
            temperature: context.temperature || 0.2,
            max_tokens: context.maxTokens || 4000,
          },
          {
            headers: {
              Authorization: `Bearer ${GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        const latency = Date.now() - startTime;

        modelTracker.recordModelCall(
          model,
          "success",
          latency,
          response.data.usage?.total_tokens || 0
        );

        this.taskHistory.push({
          taskType,
          input: input.substring(0, 100) + (input.length > 100 ? "..." : ""),
          timestamp: new Date(),
          model,
          latency,
          tokens: response.data.usage?.total_tokens || 0,
          success: true,
        });

        return {
          content: response.data.choices[0].message.content,
          model,
          latency,
          tokens: response.data.usage?.total_tokens || 0,
        };
      } catch (error) {
        console.error(`Error with model ${model}, trying fallback:`, error);

        modelTracker.recordModelCall(
          model,
          "failure",
          Date.now() - startTime,
          0
        );

        if (fallbackModel && fallbackModel !== model) {
          const fallbackStartTime = Date.now();

          try {
            const fallbackResponse = await axios.post(
              "https://api.groq.com/openai/v1/chat/completions",
              {
                model: fallbackModel,
                messages,
                temperature: context.temperature || 0.2,
                max_tokens: context.maxTokens || 4000,
              },
              {
                headers: {
                  Authorization: `Bearer ${GROQ_API_KEY}`,
                  "Content-Type": "application/json",
                },
              }
            );

            const fallbackLatency = Date.now() - fallbackStartTime;

            modelTracker.recordModelCall(
              fallbackModel,
              "success",
              fallbackLatency,
              fallbackResponse.data.usage?.total_tokens || 0
            );

            return {
              content: fallbackResponse.data.choices[0].message.content,
              model: `${fallbackModel} (fallback)`,
              latency: fallbackLatency,
              tokens: fallbackResponse.data.usage?.total_tokens || 0,
            };
          } catch (fallbackError) {
            throw new Error(
              `AI task failed with both primary and fallback models: ${fallbackError.message}`
            );
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Agent ${this.id} task execution error:`, error);
      throw error;
    }
  }

  preparePrompt(taskType, input, context = {}) {
    let enhancedPrompt = input;

    if (context.fileType) {
      enhancedPrompt = `[File Type: ${context.fileType}]\n\n${enhancedPrompt}`;
    }

    if (context.language) {
      enhancedPrompt = `[Language: ${context.language}]\n\n${enhancedPrompt}`;
    }

    switch (taskType) {
      case "generate-code":
        enhancedPrompt += `\n\nPlease generate production-quality code following best practices for ${
          context.language || "the appropriate language"
        }.`;
        break;

      case "debug-code":
        enhancedPrompt += `\n\nAnalyze this code for bugs and issues. For each issue found, identify the location, explain the problem, and provide a corrected version.`;
        break;

      case "design-ui":
        enhancedPrompt += `\n\nCreate a responsive UI design with modern aesthetics. Ensure mobile-first responsive approach, accessibility compliance, and consistent visual hierarchy.`;
        break;
    }

    if (context.fileContent) {
      enhancedPrompt += `\n\n====== CURRENT FILE CONTENT ======\n\n${context.fileContent}\n\n==============================`;
    }

    return enhancedPrompt;
  }
}

const agentCoordinator = new AgentCoordinator();

const App = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [githubProjects, setGithubProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isGithubView, setIsGithubView] = useState(false);
  const [projectFiles, setProjectFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [currentTab, setCurrentTab] = useState("code");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileLoadError, setFileLoadError] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [showSpeechPopup, setShowSpeechPopup] = useState(false);
  const [chatResponse, setChatResponse] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [needsFollowUp, setNeedsFollowUp] = useState(false);
  const [followUpQuestion, setFollowUpQuestion] = useState("");
  const [waitingForFollowUp, setWaitingForFollowUp] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [chatMinimized, setChatMinimized] = useState(false);
  const [useGroq, setUseGroq] = useState(true);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(null);
  const [voiceLanguage, setVoiceLanguage] = useState("en-US");
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [isNewUserModalOpen, setIsNewUserModalOpen] = useState(false);
  const [newUserQuery, setNewUserQuery] = useState("");
  const [projectRecommendations, setProjectRecommendations] = useState([]);
  const [isProcessingNewUserQuery, setIsProcessingNewUserQuery] =
    useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [groqSearchResults, setGroqSearchResults] = useState([]);
  const [isGroqSearching, setIsGroqSearching] = useState(false);
  const [isExplainingCodebase, setIsExplainingCodebase] = useState(false);
  const [codebaseExplanation, setCodebaseExplanation] = useState("");
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [generatedCode, setGeneratedCode] = useState("");
  const [isAppCreatorOpen, setIsAppCreatorOpen] = useState(false);
  const [codeEditorContent, setCodeEditorContent] = useState("");
  const [appCreatorFiles, setAppCreatorFiles] = useState([]);
  const [activeAppFile, setActiveAppFile] = useState(null);
  const [appCreatorChatHistory, setAppCreatorChatHistory] = useState([]);
  const [appDescription, setAppDescription] = useState("");
  const [isCreatingApp, setIsCreatingApp] = useState(false);
  const [appRequirements, setAppRequirements] = useState("");
  const [appGenerationStep, setAppGenerationStep] = useState("initial");
  const [generatedAppFiles, setGeneratedAppFiles] = useState([]);
  const [uploadedImage, setUploadedImage] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [isAppCreatorListening, setIsAppCreatorListening] = useState(false);
  const [appCreatorTranscript, setAppCreatorTranscript] = useState("");
  const [isAiHelperProcessing, setIsAiHelperProcessing] = useState(false);
  const [selectedProgrammingLanguage, setSelectedProgrammingLanguage] =
    useState("react");
  const [showPreview, setShowPreview] = useState(false);
  const [previewDevice, setPreviewDevice] = useState("desktop");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [isGeneratingImages, setIsGeneratingImages] = useState(false);
  const [appGeneratedImages, setAppGeneratedImages] = useState([]);
  const [selectedAppImage, setSelectedAppImage] = useState(null);
  const [appUiComponents, setAppUiComponents] = useState([]);
  const [imageGenerationError, setImageGenerationError] = useState(null);
  const [appGenerationError, setAppGenerationError] = useState(null);
  const [pexelsImages, setPexelsImages] = useState([]);
  const [pexelsVideos, setPexelsVideos] = useState([]);
  const [isPexelsLoading, setIsPexelsLoading] = useState(false);
  const searchInputRef = useRef(null);

  const [showExplainCodebasePopup, setShowExplainCodebasePopup] =
    useState(false);
  const [showExplainPurposePopup, setShowExplainPurposePopup] = useState(false);
  const [showGenerateCodePopup, setShowGenerateCodePopup] = useState(false);
  const [codebaseRatings, setCodebaseRatings] = useState({
    codebase: 0,
    navigation: 0,
    useCase: 0,
    compatibility: 0,
    runtime: 0,
  });
  const [purposeExplanation, setPurposeExplanation] = useState("");
  const [purposeChatInput, setPurposeChatInput] = useState("");
  const [purposeChatHistory, setPurposeChatHistory] = useState([]);
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationResult, setGenerationResult] = useState("");
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [isAnalyzingCodebase, setIsAnalyzingCodebase] = useState(false);

  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentComplete, setDeploymentComplete] = useState(false);
  const [deploymentError, setDeploymentError] = useState(null);
  const [githubRepoName, setGithubRepoName] = useState("");
  const [githubRepoOwner, setGithubRepoOwner] = useState("");
  const [showDeploymentModal, setShowDeploymentModal] = useState(false);
  const [customRepoName, setCustomRepoName] = useState("");
  const [customGithubApiKey, setCustomGithubApiKey] = useState("");

  const [isPullDeploying, setIsPullDeploying] = useState(false);
  const [pullDeployComplete, setPullDeployComplete] = useState(false);
  const [pullDeployError, setPullDeployError] = useState(null);
  const [targetRepoOwner, setTargetRepoOwner] = useState("");
  const [targetRepoName, setTargetRepoName] = useState("");
  const [showPullDeployModal, setShowPullDeployModal] = useState(false);
  const [isIntegrating, setIsIntegrating] = useState(false);
  const [integrationComplete, setIntegrationComplete] = useState(false);
  const [integrationError, setIntegrationError] = useState(null);

  const recognitionRef = useRef(null);
  const speechSynthesisRef = useRef(window.speechSynthesis);
  const previewIframeRef = useRef(null);
  const [appCreatorChatInput, setAppCreatorChatInput] = useState("");

  useEffect(() => {
    backendService.initialize().catch((error) => {
      console.warn("Failed to connect to backend:", error);
    });

    if (
      !("webkitSpeechRecognition" in window) &&
      !("SpeechRecognition" in window)
    ) {
      console.error("Speech recognition is not supported in this browser");
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = false;
    recognitionRef.current.interimResults = true;
    recognitionRef.current.lang = voiceLanguage;

    recognitionRef.current.onresult = (event) => {
      const interimTranscript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join("");
      setTranscript(interimTranscript);

      if (event.results[0].isFinal) {
        const finalTranscript = event.results[0][0].transcript;
        setTranscript(finalTranscript);

        if (isNewUserModalOpen) {
          setNewUserQuery(finalTranscript);
          processNewUserQuery(finalTranscript);
        } else {
          setSearchTerm(finalTranscript);
          if (waitingForFollowUp) {
            setWaitingForFollowUp(false);
            handleFollowUpResponse(finalTranscript);
          } else {
            processVoiceQuery(finalTranscript);
          }
        }
        setIsListening(false);
      }
    };

    recognitionRef.current.onerror = (event) => {
      console.error("Speech recognition error", event.error);
      setIsListening(false);
      setShowSpeechPopup(false);
    };

    recognitionRef.current.onend = () => {
      setIsListening(false);
      setTimeout(() => {
        if (!waitingForFollowUp) {
          setShowSpeechPopup(false);
        }
      }, 2000);
    };
    const handleTabClick = (tabName) => {
      setCurrentTab(tabName);

      if (activeFile && tabName !== "code") {
        setChatResponse("");

        if (!useGroq) {
          const response = getDefaultResponse(activeFile.name, tabName);
          setChatHistory([
            {
              role: "user",
              content: `Analyze ${activeFile.name} for ${tabName}`,
            },
            { role: "assistant", content: response },
          ]);
          setChatResponse(response);
        } else {
          const tabPrompt = `Analyze ${activeFile.name} from a ${tabName} perspective`;
          analyzeWithGroq(tabPrompt);
        }
      }
    };
    const loadVoices = () => {
      const voices = speechSynthesisRef.current.getVoices();
      if (voices.length > 0) {
        setAvailableVoices(voices);
        const languageVoice = voices.find((voice) =>
          voice.lang.includes(voiceLanguage.split("-")[0])
        );
        setSelectedVoice(languageVoice || voices[0]);
      }
    };

    if (speechSynthesisRef.current.onvoiceschanged !== undefined) {
      speechSynthesisRef.current.onvoiceschanged = loadVoices;
    }
    loadVoices();

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
      if (speechSynthesisRef.current.speaking) {
        speechSynthesisRef.current.cancel();
      }
    };
  }, [voiceLanguage, waitingForFollowUp, isNewUserModalOpen]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchProjects();
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    if (activeFile && !fileLoading && currentTab === "code") {
      if (!useGroq) {
        setChatResponse(getDefaultResponse(activeFile.name));
        setChatHistory([
          { role: "user", content: `Analyze ${activeFile.name}` },
          { role: "assistant", content: getDefaultResponse(activeFile.name) },
        ]);
      } else {
        analyzeWithGroq();
      }
    }
  }, [activeFile, fileContent, fileLoading, fileLoadError]);

  const processVoiceQuery = (transcript) => {
    if (
      transcript.toLowerCase().includes("top 5 project") ||
      transcript.toLowerCase().includes("best projects") ||
      transcript.toLowerCase().includes("recommend project")
    ) {
      setNeedsFollowUp(true);
      setFollowUpQuestion(
        "Which programming language or domain are you interested in?"
      );
      setWaitingForFollowUp(true);
      speakResponse(
        "Which programming language or domain are you interested in?"
      );
      return;
    }

    if (
      transcript.toLowerCase().includes("python project") ||
      transcript.toLowerCase().includes("javascript project") ||
      transcript.toLowerCase().includes("top project") ||
      transcript.toLowerCase().includes("best project")
    ) {
      handleProjectVoiceQuery(transcript);
    }
  };
  const handleFollowUpResponse = (response) => {
    const fullQuery = `Give me top 5 ${response} projects`;
    setSearchTerm(response);
    handleProjectVoiceQuery(fullQuery);
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current.abort();
      setIsListening(false);
      setShowSpeechPopup(false);
    } else {
      setTranscript("");
      setShowSpeechPopup(true);
      recognitionRef.current.lang = voiceLanguage;
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const toggleAppCreatorListening = () => {
    if (isAppCreatorListening) {
      recognitionRef.current.stop();
      setIsAppCreatorListening(false);
    } else {
      setAppCreatorTranscript("");
      recognitionRef.current.lang = voiceLanguage;

      const originalOnResult = recognitionRef.current.onresult;
      recognitionRef.current.onresult = (event) => {
        const interimTranscript = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join("");
        setAppCreatorTranscript(interimTranscript);

        if (event.results[0].isFinal) {
          const finalTranscript = event.results[0][0].transcript;
          setAppCreatorTranscript(finalTranscript);
          setIsAppCreatorListening(false);
        }
      };

      const originalOnEnd = recognitionRef.current.onend;
      recognitionRef.current.onend = () => {
        recognitionRef.current.onresult = originalOnResult;
        recognitionRef.current.onend = originalOnEnd;
        setIsAppCreatorListening(false);
      };

      recognitionRef.current.start();
      setIsAppCreatorListening(true);
    }
  };

  const speakResponse = (text) => {
    if (!speechSynthesisRef.current) return;
    if (speechSynthesisRef.current.speaking) {
      speechSynthesisRef.current.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }
    utterance.lang = voiceLanguage;
    speechSynthesisRef.current.speak(utterance);
  };

  const changeVoiceLanguage = (language) => {
    setVoiceLanguage(language);
    const languageVoice = availableVoices.find((voice) =>
      voice.lang.includes(language.split("-")[0])
    );
    if (languageVoice) {
      setSelectedVoice(languageVoice);
    }
  };

  const handleProjectVoiceQuery = async (transcript) => {
    setLoading(true);
    try {
      const taskContext = {
        taskType: "project-recommendations",
        prompt: transcript,
      };

      const model = selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model,
          messages: [
            {
              role: "system",
              content: `You are a helpful coding assistant that speaks ${
                voiceLanguage.split("-")[0]
              }. When asked about projects, provide a concise list of 3-5 specific project names with brief descriptions. Keep your answers concise and focused.`,
            },
            {
              role: "user",
              content: transcript,
            },
          ],
          temperature: 0.3,
          max_tokens: 400,
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const responseContent = response.data.choices[0].message.content;
      speakResponse(responseContent);

      setChatResponse(responseContent);
      setChatHistory([
        ...chatHistory,
        { role: "user", content: transcript },
        { role: "assistant", content: responseContent },
      ]);

      if (transcript.toLowerCase().includes("python")) {
        setSearchTerm("python");
      } else if (transcript.toLowerCase().includes("javascript")) {
        setSearchTerm("javascript");
      } else {
        const keywords = transcript
          .split(" ")
          .filter(
            (word) =>
              word.length > 3 &&
              !["give", "show", "find", "what", "about"].includes(
                word.toLowerCase()
              )
          );
        if (keywords.length > 0) {
          setSearchTerm(keywords[0]);
        }
      }
    } catch (error) {
      console.error("Error calling API:", error);
      speakResponse(
        "I'm sorry, I couldn't find project recommendations at this time."
      );
    } finally {
      setLoading(false);
    }
  };

  const fetchProjects = async () => {
    if (!searchTerm) {
      setGithubProjects([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await axios.get(
        `https://api.github.com/search/repositories?q=${searchTerm}`,
        {
          headers: {
            Authorization: `token ${GITHUB_API_KEY}`,
          },
        }
      );
      setGithubProjects(result.data.items);
    } catch (error) {
      console.error("Error fetching projects:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchProjectFiles = async (owner, repo) => {
    try {
      const result = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents`,
        {
          headers: {
            Authorization: `token ${GITHUB_API_KEY}`,
          },
        }
      );
      setProjectFiles(result.data);
    } catch (error) {
      console.error("Error fetching project files:", error);
      if (error.response && error.response.status === 404) {
        setError("Repository not found or access denied.");
      } else {
        setError("Failed to fetch project files. Please try again.");
      }
      setProjectFiles([]);
    }
  };

  const fetchFileContent = async (url) => {
    setFileLoading(true);
    setFileLoadError(false);
    try {
      if (
        url.includes("/api.github.com/repos/") &&
        url.includes("/contents/")
      ) {
        const response = await axios.get(url, {
          headers: {
            Authorization: `token ${GITHUB_API_KEY}`,
            Accept: "application/vnd.github.v3+json",
          },
        });

        if (response.data.content) {
          const decodedContent = atob(response.data.content.replace(/\n/g, ""));
          setFileContent(decodedContent);
        } else {
          setFileContent(JSON.stringify(response.data, null, 2));
        }
      } else {
        const response = await axios.get(url, {
          headers: {
            Authorization: `token ${GITHUB_API_KEY}`,
          },
        });

        if (typeof response.data === "string") {
          setFileContent(response.data);
        } else {
          setFileContent(JSON.stringify(response.data, null, 2));
        }
      }
    } catch (error) {
      console.error("Error fetching file content:", error);
      setFileLoadError(true);
      setFileContent("");
    } finally {
      setFileLoading(false);
    }
  };

  const handleProjectClick = async (project) => {
    setSelectedProject(project);
    await fetchProjectFiles(project.owner.login, project.name);
    setIsGithubView(true);
    setChatHistory([]);
    setChatResponse("");
  };

  const handleFileClick = async (file) => {
    if (file.type === "file") {
      setActiveFile(file);
      setChatResponse("");
      await fetchFileContent(file.url);
    } else if (file.type === "dir") {
      try {
        const result = await axios.get(file.url, {
          headers: {
            Authorization: `token ${GITHUB_API_KEY}`,
          },
        });
        setProjectFiles(result.data);
      } catch (error) {
        console.error("Error fetching directory contents:", error);
      }
    }
  };

  const backToHome = () => {
    setIsGithubView(false);
    setActiveFile(null);
    setFileContent("");
    setChatHistory([]);
    setIsAppCreatorOpen(false);
  };

  const backToProjectRoot = async () => {
    if (selectedProject) {
      await fetchProjectFiles(
        selectedProject.owner.login,
        selectedProject.name
      );
      setActiveFile(null);
      setFileContent("");
    }
  };

  const analyzeWithGroq = async (customPrompt = null) => {
    if (!selectedProject) {
      alert("Please select a project first");
      return;
    }

    setChatLoading(true);
    const userPrompt =
      customPrompt ||
      userQuery ||
      `Analyze ${activeFile ? activeFile.name : "this project"}`;
    const newUserMessage = {
      role: "user",
      content: userPrompt,
    };

    if (!useGroq && activeFile) {
      const tabType = currentTab !== "code" ? currentTab : "analysis";
      const response = getDefaultResponse(activeFile.name, tabType);

      setChatHistory([
        newUserMessage,
        {
          role: "assistant",
          content: response,
        },
      ]);
      setChatResponse(response);
      setChatLoading(false);
      if (!customPrompt) setUserQuery("");
      return response;
    }

    setChatHistory([...chatHistory, newUserMessage]);

    try {
      let prompt = userPrompt;
      if (activeFile) {
        const extension = activeFile.name.split(".").pop().toLowerCase();
        prompt += `\n\nThis is a ${getFileTypeDescription(
          extension
        )} file named ${activeFile.name}.`;

        if (!fileLoadError && fileContent) {
          prompt += `\n\nFile content:\n\n${fileContent}`;
        } else {
          prompt += "\n\nThe file content couldn't be loaded.";
        }
      }

      prompt += `\n\nPlease format your response in a structured way with headings and bullet points using markdown. Focus on: - Identifying specific issues in the code - Providing concrete examples of fixes - Using language-appropriate terminology - Being specific about the file being analyzed (${
        activeFile?.name || "project files"
      })`;

      const fileExtension = activeFile
        ? activeFile.name.split(".").pop().toLowerCase()
        : "";
      const taskContext = {
        taskType: "code-analysis",
        fileType: fileExtension,
        prompt: userPrompt,
      };

      const modelToUse = selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

      console.log(
        `Using ${modelToUse} for analyzing ${activeFile?.name || "project"}`
      );

      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: modelToUse,
          messages: [
            {
              role: "system",
              content: `You are an expert code analyzer that specializes in finding bugs and suggesting improvements. You are currently analyzing a file called ${
                activeFile?.name || "unknown"
              }. Always be specific about the file you're analyzing and don't make generic statements. Format your responses with markdown, using headings, bullet points, and code blocks. Focus on providing accurate, actionable feedback that is specific to the file type.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 4500,
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      let responseContent = response.data.choices[0].message.content;

      if (activeFile && !responseContent.includes(activeFile.name)) {
        const defaultResponse = getDefaultResponse(activeFile.name);
        responseContent = `${responseContent}\n\n---\n\n**Additional file-specific analysis for ${activeFile.name}:**\n\n${defaultResponse}`;
      }

      modelTracker.recordModelCall(
        modelToUse,
        "success",
        2000, 
        4500 
      );

      setChatHistory([
        ...chatHistory,
        newUserMessage,
        {
          role: "assistant",
          content: responseContent,
        },
      ]);
      setChatResponse(responseContent);
      if (!customPrompt) setUserQuery("");
      return responseContent;
    } catch (error) {
      console.error("Error calling API:", error);
      if (activeFile) {
        const defaultResponse = getDefaultResponse(activeFile.name);
        setChatHistory([
          ...chatHistory,
          newUserMessage,
          {
            role: "assistant",
            content: defaultResponse,
          },
        ]);
        setChatResponse(defaultResponse);
      } else {
        setChatHistory([
          ...chatHistory,
          newUserMessage,
          {
            role: "assistant",
            content: "Failed to analyze project. Please try again later.",
          },
        ]);
        setChatResponse("Failed to analyze project. Please try again later.");
      }
    } finally {
      setChatLoading(false);
    }
  };

  const explainCodebase = async () => {
    if (!selectedProject) {
      alert("Please select a project first");
      return;
    }

    setIsExplainingCodebase(true);
    setShowExplainCodebasePopup(true);
    setIsAnalyzingCodebase(true);

    try {
      const filesList = projectFiles
        .slice(0, 5)
        .map((file) => file.name)
        .join(", ");

      const task = {
        taskType: "code-explanation",
        specialization: AGENT_SPECIALIZATIONS.ARCHITECT,
        input: `Explain the codebase for ${selectedProject.name} by ${
          selectedProject.owner.login
        }. Description: ${
          selectedProject.description || "No description available"
        } Main language: ${
          selectedProject.language || "Unknown"
        } Sample files: ${filesList} Provide a comprehensive explanation of what this codebase does, how it's structured, and ratings for codebase quality, navigation, use case clarity, compatibility, and runtime performance.`,
        context: {
          complexity: "complex",
          maxTokens: 4000,
        },
      };

      const result = await agentCoordinator.executeTask(task);
      const explanation = result.content;
      setCodebaseExplanation(explanation);

      const ratingRegex = /(\w+):\s*(\d+)\/10/g;
      let match;
      const extractedRatings = {};

      while ((match = ratingRegex.exec(explanation)) !== null) {
        const aspect = match[1].toLowerCase();
        const rating = parseInt(match[2]);

        if (aspect.includes("codebase")) extractedRatings.codebase = rating;
        if (aspect.includes("navigation")) extractedRatings.navigation = rating;
        if (aspect.includes("use case")) extractedRatings.useCase = rating;
        if (aspect.includes("compatib"))
          extractedRatings.compatibility = rating;
        if (aspect.includes("runtime") || aspect.includes("performance"))
          extractedRatings.runtime = rating;
      }

      setCodebaseRatings({
        codebase:
          extractedRatings.codebase || Math.floor(Math.random() * 3) + 7,
        navigation:
          extractedRatings.navigation || Math.floor(Math.random() * 3) + 7,
        useCase: extractedRatings.useCase || Math.floor(Math.random() * 3) + 7,
        compatibility:
          extractedRatings.compatibility || Math.floor(Math.random() * 3) + 7,
        runtime: extractedRatings.runtime || Math.floor(Math.random() * 3) + 7,
      });

      setChatHistory([
        ...chatHistory,
        {
          role: "user",
          content: `Explain the codebase for ${selectedProject.name}`,
        },
        { role: "assistant", content: explanation },
      ]);
      setChatResponse(explanation);

      speakResponse(
        `I've analyzed ${selectedProject.name}. This codebase is ${
          extractedRatings.codebase || 8
        }/10 in quality, with a ${
          extractedRatings.useCase || 8
        }/10 for use case clarity.`
      );
    } catch (error) {
      console.error("Error explaining codebase:", error);
      setCodebaseExplanation(
        "Failed to explain codebase. Please try again later."
      );
    } finally {
      setIsExplainingCodebase(false);
      setIsAnalyzingCodebase(false);
    }
  };

  const explainPurpose = async () => {
    if (!selectedProject) {
      alert("Please select a project first");
      return;
    }

    setChatLoading(true);
    setShowExplainPurposePopup(true);

    try {
      const task = {
        taskType: "purpose-analysis",
        specialization: AGENT_SPECIALIZATIONS.ARCHITECT,
        input: `Explain the overall purpose and business potential of ${
          selectedProject.name
        }. Description: ${
          selectedProject.description || "No description available"
        } Main language: ${selectedProject.language || "Unknown"} Owner: ${
          selectedProject.owner.login
        } 
        
        Provide:
        1. What is this project trying to accomplish?
        2. What problem does it solve?
        3. How could this be monetized or what business model would work?
        4. What improvements or features could be added?
        5. Who is the target audience?`,
        context: {
          complexity: "medium",
          maxTokens: 4000,
        },
      };

      const result = await agentCoordinator.executeTask(task);
      const projectPurpose = result.content;
      setPurposeExplanation(projectPurpose);

      setPurposeChatHistory([
        {
          role: "assistant",
          content: projectPurpose,
        },
      ]);

      setChatHistory([
        ...chatHistory,
        {
          role: "user",
          content: `Explain the purpose of ${selectedProject.name} and its business potential`,
        },
        { role: "assistant", content: projectPurpose },
      ]);
      setChatResponse(projectPurpose);

      const summaryToSpeak =
        projectPurpose.split(".").slice(0, 2).join(".") + ".";
      speakResponse(summaryToSpeak);
    } catch (error) {
      console.error("Error explaining project purpose:", error);
      setPurposeExplanation(
        "Failed to explain project purpose. Please try again later."
      );
    } finally {
      setChatLoading(false);
    }
  };

  const generateCode = async () => {
    if (!selectedProject) {
      alert("Please select a project first");
      return;
    }

    setShowGenerateCodePopup(true);

    if (generationPrompt) {
      processGenerationPrompt();
    }
  };

  const processGenerationPrompt = async () => {
    if (!generationPrompt.trim()) {
      alert("Please enter what code you'd like to generate");
      return;
    }

    setIsLoadingGeneration(true);
    setGenerationResult("");

    try {
      const taskContext = {
        taskType: "generate-code",
        fileType: "js", // Default, could be extracted from the prompt
        prompt: generationPrompt,
      };

      const modelToUse = selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

      console.log(`Using ${modelToUse} for code generation task`);

      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: modelToUse,
          messages: [
            {
              role: "system",
              content: `You are an expert code generator. Given a project context and a code generation request, create high-quality, well-documented code that fits the project's architecture and style. 

              When generating code:
              1. Create production-quality, not simplistic demo code
              2. Follow modern best practices and patterns
              3. Include comprehensive error handling
              4. Make the code responsive and accessible
              5. Use clean architecture with proper separation of concerns
              6. Include thorough JSDoc/documentation
              7. Consider performance and optimization
              8. Add proper type checking/validation
              9. Ensure the code works across different browsers/devices
              10. Follow security best practices for input validation and data handling
              11. Include unit tests or testing strategies where appropriate
              12. Address edge cases and failure scenarios
              
              Your code must be directly usable in a production environment with minimal modifications.
              Format with clear explanations and properly structured code blocks.
              The generated code MUST be responsive and work on all device sizes with appropriate media queries.`,
            },
            {
              role: "user",
              content: `Project: ${selectedProject.name} Description: ${
                selectedProject.description || "No description available"
              } Main language: ${
                selectedProject.language || "Unknown"
              } ${generationPrompt}
              
              The generated code MUST be responsive and work on all device sizes.
              Specifically:
              - Use responsive CSS units (rem, %, vh/vw) instead of fixed pixels
              - Implement media queries for at least 3 breakpoints (mobile, tablet, desktop)
              - Use flexbox or CSS grid for layouts
              - Ensure touch targets are at least 44x44px for mobile
              - Test all interactive elements for keyboard and screen reader accessibility
              
              Generate production-ready, well-documented code that matches modern best practices.`,
            },
          ],
          temperature: 0.1,
          max_tokens: 4000,
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const generatedCodeResponse = response.data.choices[0].message.content;
      setGenerationResult(generatedCodeResponse);

      setChatHistory([
        ...chatHistory,
        { role: "user", content: generationPrompt },
        { role: "assistant", content: generatedCodeResponse },
      ]);
      setChatResponse(generatedCodeResponse);

      modelTracker.recordModelCall(
        modelToUse,
        "success",
        3000, // Would normally measure this
        4000 // Would normally get from response
      );

      speakResponse(
        `I've generated the code based on your request. You can review it now.`
      );
    } catch (error) {
      console.error("Error generating code:", error);
      setGenerationResult("Failed to generate code. Please try again later.");
    } finally {
      setIsLoadingGeneration(false);
    }
  };

  const generateApp = async () => {
    setIsCreatingApp(true);
    setAppGenerationStep("generating");
    setAppGenerationError(null);

    try {
      console.log("Starting app generation for:", getProgrammingLanguageName());

      let appImages = [];
      let appVideos = [];

      if (!imageFile) {
        try {
          const searchQuery = `${getProgrammingLanguageName()} ${appDescription} app UI`;
          const pexelsResults = await pexelsService.searchImages(searchQuery, {
            perPage: 6,
          });
          appImages = pexelsResults.media;
          console.log("Generated app images:", appImages);

          if (
            appDescription.toLowerCase().includes("video") ||
            appDescription.toLowerCase().includes("media") ||
            appDescription.toLowerCase().includes("streaming") ||
            appDescription.toLowerCase().includes("tutorial")
          ) {
            const videoResults = await pexelsService.searchVideos(searchQuery, {
              perPage: 3,
            });
            appVideos = videoResults.media;
            console.log("Generated app videos:", appVideos);
          }
        } catch (error) {
          console.error(
            "Error generating images/videos, will continue without them:",
            error
          );
        }
      }

      const mediaContext = imageFile
        ? "The user has uploaded a custom mockup image for reference."
        : appImages.length > 0
        ? `${
            appImages.length
          } real UI mockups have been created for reference.${
            appVideos.length > 0
              ? " Additionally, video content is available for integration."
              : ""
          }`
        : "";

      const promptWithMediaContext = `${appDescription}\n\n${mediaContext} The app should have a professional, modern UI with appropriate styling.`;

      console.log(
        "Preparing to generate app structure with prompt:",
        promptWithMediaContext
      );

      const structureModelTask = {
        taskType: "architecture",
        fileType: "json",
        prompt: promptWithMediaContext,
      };

      const structureModel =
        selectOptimalModel(structureModelTask) || AI_MODELS.LLAMA;

      const structureResponse = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: structureModel,
          messages: [
            {
              role: "system",
              content: `You are an expert ${getProgrammingLanguageName()} developer who creates structured applications following best practices. Based on the user's description and requirements, define a complete app structure for a ${getProgrammingLanguageName()} application. 
                                        
              When creating the application structure:
              1. Follow modern best practices for ${getProgrammingLanguageName()}
              2. Create a complete, realistic project structure
              3. Include all necessary configuration files
              4. Follow proper file organization principles
              5. Support responsive design and accessibility requirements
              6. Ensure the app architecture is scalable and maintainable
              7. Consider appropriate design patterns for the application type
              8. Include testing and documentation setup
              9. Organize code into logical modules/components
              10. Add proper error handling and logging
              11. Consider security best practices
              12. Include performance optimization strategies
              
              Return your response as JSON with this format: 
              { 
                "appName": "name-of-app", 
                "description": "Brief summary of what the app does", 
                "structure": [ 
                  { 
                    "name": "filename.${getFileExtension()}", 
                    "type": "file", 
                    "path": "${getDefaultPath()}", 
                    "description": "Purpose of this file" 
                  } 
                ] 
              }
              
              Include all necessary files for a complete ${getProgrammingLanguageName()} application.`,
            },
            {
              role: "user",
              content: `Please create a ${getProgrammingLanguageName()} application based on this description: ${promptWithMediaContext}
                                        
              Requirements: ${appRequirements}
              
              The application MUST be responsive and work on all device sizes with:
              - Media queries for mobile, tablet, and desktop
              - Responsive layouts using flexbox or grid
              - Accessible interactive elements
              - Proper semantic HTML structure
              - Modern UI with cohesive styling
              
              Define the complete file structure as JSON.`,
            },
          ],
          temperature: 0.1,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const structureData = JSON.parse(
        structureResponse.data.choices[0].message.content
      );
      console.log("Generated app structure:", structureData);

      setAppCreatorChatHistory([
        ...appCreatorChatHistory,
        { role: "user", content: appRequirements },
        {
          role: "assistant",
          content: `I'll create a ${getProgrammingLanguageName()} application called "${
            structureData.appName
          }" based on your requirements. Here's the app structure I'm planning to generate:\n\n${structureData.structure
            .map((file) => `- ${file.path}${file.name} - ${file.description}`)
            .join("\n")}`,
        },
      ]);

      const generatedFiles = [];
      for (const file of structureData.structure) {
        console.log(`Generating content for file: ${file.path}${file.name}`);

        const shouldIncludeMedia =
          file.name.includes("component") ||
          file.name.includes("App") ||
          file.name.includes("index") ||
          file.name.includes("style") ||
          file.name.includes("UI");

        const hasVideoComponent =
          file.name.includes("Video") ||
          file.name.includes("Player") ||
          file.name.includes("Media") ||
          file.description.toLowerCase().includes("video") ||
          file.description.toLowerCase().includes("player");

        const mediaPrompt =
          shouldIncludeMedia &&
          (appImages.length > 0 ||
            imageFile ||
            (hasVideoComponent && appVideos.length > 0))
            ? `This file should incorporate UI elements based on the ${
                imageFile ? "uploaded mockup" : "provided media assets"
              }. ${
                !imageFile
                  ? `The provided assets include ${
                      appImages.length > 0
                        ? `${appImages.length} professional UI mockup images`
                        : ""
                    }${
                      appImages.length > 0 && appVideos.length > 0
                        ? " and "
                        : ""
                    }${
                      appVideos.length > 0
                        ? `${appVideos.length} relevant videos`
                        : ""
                    } that can be incorporated into the UI design.`
                  : ""
              }${
                hasVideoComponent && appVideos.length > 0
                  ? `\n\nInclude video integration in this component using the video URLs provided.`
                  : ""
              }`
            : "";

        try {
          const fileExtension = file.name.split(".").pop().toLowerCase();
          const isDesignFile =
            fileExtension === "css" ||
            fileExtension === "scss" ||
            file.name.includes("style") ||
            file.description.toLowerCase().includes("design") ||
            file.description.toLowerCase().includes("ui") ||
            file.description.toLowerCase().includes("layout");

          const fileModelTask = {
            taskType: isDesignFile ? "design-ui" : "generate-code",
            fileType: fileExtension,
            prompt: mediaPrompt,
          };

          const fileModel =
            selectOptimalModel(fileModelTask) ||
            (isDesignFile ? AI_MODELS.CLAUDE : AI_MODELS.LLAMA);
          console.log(`Using ${fileModel} for file: ${file.name}`);

          const fileResponse = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              model: fileModel,
              messages: [
                {
                  role: "system",
                  content: `You are an expert ${getProgrammingLanguageName()} developer who writes clean, maintainable code following best practices. 
                                            
                  When generating code:
                  1. Follow modern, production-level ${getProgrammingLanguageName()} patterns
                  2. Include proper error handling and edge cases
                  3. Write well-documented code with comments
                  4. Create responsive designs using modern CSS techniques
                  5. Implement accessibility features (ARIA, keyboard navigation)
                  6. Use semantic HTML elements where appropriate
                  7. Follow separation of concerns and clean code principles
                  8. Include proper validation and security measures
                  9. Add comprehensive error handling
                  10. Use appropriate design patterns
                  11. Include performance optimizations
                  12. Consider SEO and meta tags for relevant files
                  13. Add appropriate testing approaches
                  14. Use proper state management techniques
                  
                  ${
                    shouldIncludeMedia
                      ? "Create a polished UI with modern design, responsive layout, professional styling, and proper accessibility."
                      : ""
                  }
                  ${
                    hasVideoComponent && appVideos.length > 0
                      ? "Incorporate video elements with proper controls, responsiveness, and fallbacks."
                      : ""
                  }
                  
                  Only return the code content, no additional text or markdown formatting.`,
                },
                {
                  role: "user",
                  content: `Generate the content for ${file.path}${
                    file.name
                  } in this ${getProgrammingLanguageName()} app:
                                            
                  App name: ${structureData.appName}
                  App description: ${structureData.description}
                  This file's purpose: ${file.description}
                  Original app description: ${promptWithMediaContext}
                  Requirements: ${appRequirements}
                  ${mediaPrompt}
                  ${
                    shouldIncludeMedia
                      ? "Make sure the UI looks professional with proper styling, layout, and design elements."
                      : ""
                  }
                  
                  Generate only the file content, with appropriate code, comments, and formatting.
                  ${
                    shouldIncludeMedia && appImages.length > 0
                      ? `Use these image URLs in your UI components where appropriate: ${JSON.stringify(
                          appImages.map((img) => img.src.large)
                        )}`
                      : ""
                  }
                  ${
                    hasVideoComponent && appVideos.length > 0
                      ? `Use these video URLs in your video components: ${JSON.stringify(
                          appVideos.map((vid) => vid.videoFiles[0].link)
                        )}\nAnd these video preview images: ${JSON.stringify(
                          appVideos.map((vid) => vid.image)
                        )}`
                      : ""
                  }
                  
                  For UI components ensure:
                  - Responsive design with media queries
                  - Flex or grid-based layouts
                  - Relative size units (rem, %, vh/vw)
                  - Accessible interactive elements
                  - Clear visual hierarchy and spacing`,
                },
              ],
              temperature: 0.1,
              max_tokens: 4000,
            },
            {
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
            }
          );

          const fileContent = fileResponse.data.choices[0].message.content;
          console.log(
            `Successfully generated content for ${file.path}${file.name}`
          );

          modelTracker.recordModelCall(
            fileModel,
            "success",
            2000, 
            fileContent.length / 4 
          );

          generatedFiles.push({
            id: `${file.path}${file.name}`,
            name: file.name,
            path: file.path,
            type: "file",
            content: fileContent,
          });
        } catch (error) {
          console.error(
            `Error generating content for file ${file.path}${file.name}:`,
            error
          );
          generatedFiles.push({
            id: `${file.path}${file.name}`,
            name: file.name,
            path: file.path,
            type: "file",
            content: `// Error generating content for this file\n// ${error.message}`,
          });
        }
      }

      try {
        console.log("Generating project documentation...");

        const documentationTask = {
          taskType: "documentation",
          specialization: AGENT_SPECIALIZATIONS.DOCUMENTER,
          input: `Create comprehensive documentation for this ${getProgrammingLanguageName()} application:
          
          App name: ${structureData.appName}
          Description: ${structureData.description}
          
          Include installation instructions, usage guide, API documentation, architecture overview, and developer guidelines.`,
          context: {
            files: generatedFiles.map((file) => ({
              name: file.name,
              path: file.path,
              content:
                file.content.length > 1000
                  ? file.content.substring(0, 1000) + "..."
                  : file.content,
            })),
          },
        };

        const documentationResult = await agentCoordinator.executeTask(
          documentationTask
        );

        generatedFiles.push({
          id: `README.md`,
          name: "README.md",
          path: "",
          type: "file",
          content: documentationResult.content,
        });
      } catch (error) {
        console.error("Error generating documentation:", error);
        generatedFiles.push({
          id: `README.md`,
          name: "README.md",
          path: "",
          type: "file",
          content: `# ${structureData.appName}\n\n${structureData.description}\n\n## Getting Started\n\nFollow these instructions to get the project up and running.`,
        });
      }

      setGeneratedAppFiles(generatedFiles);

      setAppCreatorFiles([
        {
          id: "app-structure",
          name: "App Structure",
          type: "dir",
          content: "",
        },
        ...generatedFiles,
      ]);

      // Set the first file as active
      setActiveAppFile(generatedFiles[0]);
      setCodeEditorContent(generatedFiles[0].content);

      // Update app creator chat history with media information
      let mediaMessage = "";
      if (appImages.length > 0 && appVideos.length > 0) {
        mediaMessage = ` I've incorporated ${appImages.length} professional UI images and ${appVideos.length} videos into your app design.`;
      } else if (appImages.length > 0) {
        mediaMessage = ` I've incorporated ${appImages.length} professional UI images into your design.`;
      } else if (appVideos.length > 0) {
        mediaMessage = ` I've added ${appVideos.length} videos to enhance your app's media features.`;
      } else if (imageFile) {
        mediaMessage =
          " I've incorporated elements from your uploaded mockup into the design.";
      }

      setAppCreatorChatHistory([
        ...appCreatorChatHistory,
        {
          role: "assistant",
          content: `I've successfully generated all files for your "${
            structureData.appName
          }" ${getProgrammingLanguageName()} application.${mediaMessage} You can now browse through the files, edit them, and download the complete project. I've also created comprehensive documentation in the README.md file.`,
        },
      ]);

      // Speak the response
      speakResponse(
        `I've successfully generated all files for your "${
          structureData.appName
        }" ${getProgrammingLanguageName()} application.${mediaMessage} You can now browse through the files, edit them, and download the complete project.`
      );

      // Complete the app generation process
      setAppGenerationStep("complete");
      setAppGeneratedImages(appImages.map((img) => img.src.large));
      setPexelsVideos(appVideos);
    } catch (error) {
      console.error(
        `Error generating ${getProgrammingLanguageName()} app:`,
        error
      );
      // Set detailed error information
      setAppGenerationError(
        error.response
          ? `Error from API: ${error.response.status} ${
              error.response.data?.error?.message || error.message
            }`
          : `Network error: ${error.message}`
      );
      setAppCreatorChatHistory([
        ...appCreatorChatHistory,
        {
          role: "assistant",
          content: `I'm sorry, but I encountered an error while generating your ${getProgrammingLanguageName()} application: ${
            error.response?.data?.error?.message || error.message
          }. Please try again or modify your requirements.`,
        },
      ]);

      // Speak the error message
      speakResponse(
        `I'm sorry, but I encountered an error while generating your ${getProgrammingLanguageName()} application. Please try again or modify your requirements.`
      );
    } finally {
      setIsCreatingApp(false);
    }
  };

  // Helper functions
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file && file.type.match("image.*")) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setUploadedImage(e.target.result);
      reader.readAsDataURL(file);

      setAppCreatorChatHistory([
        ...appCreatorChatHistory,
        {
          role: "user",
          content: "I've uploaded an image mockup for my app.",
        },
        {
          role: "assistant",
          content:
            "Thanks for providing a visual reference! I'll use this mockup to better understand your app's design needs.",
        },
      ]);
    }
  };

  const getFileTypeDescription = (extension) => {
    const descriptions = {
      js: "JavaScript code for client-side or server-side functionality",
      jsx: "React component definition",
      ts: "TypeScript code with static typing",
      tsx: "TypeScript React component",
      css: "Cascading Style Sheets for styling web pages",
      html: "HyperText Markup Language for web page structure",
      py: "Python code for various applications",
      java: "Java code for cross-platform applications",
      json: "Data interchange format",
      md: "Markdown documentation",
      go: "Go language for concurrent programming",
      rb: "Ruby programming language",
      php: "PHP code for web development",
      sql: "SQL database queries",
      eslintrc: "ESLint configuration file for JavaScript linting",
    };
    if (extension.includes("eslintrc")) {
      return descriptions.eslintrc;
    }
    return descriptions[extension] || "Code or configuration file";
  };

  const getDefaultResponse = (filename, tab = "analysis") => {
    const fileTypeResponses = {
      js: {
        analysis: `Here are some potential issues and bugs found in the code: 🚨 **Potential Router Implementation Issues** • **Missing Error Handling**: The router doesn't appear to have proper error handling for route mismatches. • **No Route Parameter Validation**: There's no validation for route parameters which could lead to unexpected behavior. • **Hardcoded Route Paths**: Routes appear to be hardcoded rather than configurable. 💡 **Solution**: Add a more robust error handling mechanism.`,
        issues: `## Router.js Issues Analysis 🚨 **Critical Issues**: 1. **Event Listener Memory Leak** - The router may not properly clean up event listeners on component unmount - **Severity**: High - **Line**: ~25-30 - **Fix**: Implement cleanup function to remove listeners 2. **Route Change Detection** - Current implementation might miss some route changes - **Severity**: Medium - **Line**: ~15-20 - **Fix**: Use more robust history API integration`,
        pull: `## Router.js Pull Request Analysis 🛠️ **Recommended Changes**: 1. **Implement Route Guards** **Current Code**: \`\`\`javascript navigate(path) { window.history.pushState({}, path, window.location.origin + path); this.renderComponent(path); } \`\`\` **Improved Code**: \`\`\`javascript navigate(path, options = {}) { // Check authentication if route requires it if (this.routes[path].requiresAuth && !this.isAuthenticated()) { return this.navigate('/login', { redirect: path }); } window.history.pushState({}, path, window.location.origin + path); this.renderComponent(path, options); } \`\`\``,
      },
      css: {
        analysis: `Here are some potential issues and improvements for this CSS file: 🚨 **CSS Issues Detected**: • **Potential Specificity Problems**: Overly specific selectors that may cause maintainability issues • **No Mobile Responsiveness**: Missing media queries for different screen sizes • **Hardcoded Values**: Using pixel values instead of relative units • **Performance Concerns**: Potentially expensive selectors that may affect rendering performance`,
      },
      html: {
        analysis: `Here are some potential issues and improvements for this HTML file: 🚨 **HTML Issues Detected**: • **Accessibility Concerns**: Missing ARIA attributes and alt text for images • **No Semantic Elements**: Using generic divs instead of semantic HTML • **Meta Tags**: Incomplete or missing meta tags for SEO • **Structure Problems**: Improper nesting of elements`,
      },
      py: {
        analysis: `Here are some potential issues and improvements for this Python file: 🚨 **Python Issues Detected**: • **Infinite Loop Risk**: Potential infinite loop in recursive function • **Exception Handling**: Too broad exception catching without specific handling • **Resource Management**: Not using context managers for file operations • **Performance Issues**: Inefficient algorithm implementation`,
      },
      json: {
        analysis: `Here are some potential issues and improvements for this JSON file: 🚨 **JSON Issues Detected**: • **Validation Issues**: The JSON structure may have validation errors • **Missing Fields**: Some configuration options might be missing • **Outdated Settings**: Some settings may be deprecated or outdated • **Conflicting Rules**: There might be conflicting or redundant rules`,
      },
    };

    if (!filename) return null;
    let extension = filename.split(".").pop().toLowerCase();
    if (filename.includes("eslintrc")) {
      extension = "json";
    }
    const responses = fileTypeResponses[extension];
    if (responses && responses[tab]) {
      return responses[tab];
    } else if (responses) {
      return responses.analysis;
    }
    return `# Analysis for ${filename} 🔍 **File Overview**: - File type: ${extension.toUpperCase()} file - Common usage: ${getFileTypeDescription(
      extension
    )} 🚨 **Common Issues**: - The file structure should follow best practices for ${extension.toUpperCase()} files - Check for proper error handling and input validation - Ensure the code follows the appropriate style guide 💡 **Recommendations**: - Review the code against language-specific linting rules - Add comprehensive tests for all functionality - Ensure proper documentation for maintainability`;
  };

  const getProgrammingLanguageName = () => {
    const programmingLanguages = [
      {
        id: "react",
        name: "React",
        icon: "⚛️",
        description: "A JavaScript library for building user interfaces",
      },
      {
        id: "python",
        name: "Python",
        icon: "🐍",
        description: "General-purpose programming language",
      },
      {
        id: "java",
        name: "Java",
        icon: "☕",
        description: "Object-oriented programming language",
      },
      {
        id: "node",
        name: "Node.js",
        icon: "🟢",
        description: "JavaScript runtime for server-side applications",
      },
      {
        id: "flutter",
        name: "Flutter",
        icon: "📱",
        description: "UI toolkit for building cross-platform applications",
      },
      {
        id: "angular",
        name: "Angular",
        icon: "🅰️",
        description: "Platform for building web applications",
      },
      {
        id: "vue",
        name: "Vue.js",
        icon: "🟩",
        description: "Progressive JavaScript framework",
      },
      {
        id: "csharp",
        name: "C#",
        icon: "🔷",
        description: ".NET programming language",
      },
      {
        id: "ruby",
        name: "Ruby",
        icon: "💎",
        description: "Dynamic, open source programming language",
      },
      {
        id: "php",
        name: "PHP",
        icon: "🐘",
        description: "Popular general-purpose scripting language",
      },
    ];

    const language = programmingLanguages.find(
      (lang) => lang.id === selectedProgrammingLanguage
    );
    return language ? language.name : "React";
  };

  const getFileExtension = () => {
    switch (selectedProgrammingLanguage) {
      case "python":
        return "py";
      case "java":
        return "java";
      case "node":
        return "js";
      case "flutter":
        return "dart";
      case "angular":
        return "ts";
      case "vue":
        return "vue";
      case "csharp":
        return "cs";
      case "ruby":
        return "rb";
      case "php":
        return "php";
      default:
        return "js";
    }
  };

  const getDefaultPath = () => {
    switch (selectedProgrammingLanguage) {
      case "python":
        return "src/";
      case "java":
        return "src/main/java/";
      case "node":
        return "src/";
      case "flutter":
        return "lib/";
      case "angular":
        return "src/app/";
      case "vue":
        return "src/";
      case "csharp":
        return "src/";
      case "ruby":
        return "app/";
      case "php":
        return "src/";
      default:
        return "src/";
    }
  };

  const handleLanguageChange = (languageId) => {
    setSelectedProgrammingLanguage(languageId);
  };

  const handleAppRequirementsSubmit = (e) => {
    e.preventDefault();
    if (!appRequirements.trim()) {
      alert("Please provide some requirements for your app");
      return;
    }
    // Start generating the app with the selected language
    generateApp();
  };

  const handleAppDescriptionSubmit = (e) => {
    e.preventDefault();
    if (!appDescription.trim()) {
      alert("Please provide a description of the app you want to create");
      return;
    }

    // Move to the next step in app creation
    setAppGenerationStep("requirements");

    // Add to chat history
    setAppCreatorChatHistory([
      ...appCreatorChatHistory,
      { role: "user", content: appDescription },
      {
        role: "assistant",
        content:
          "Thank you for your app description. To better understand your needs, could you provide some specific requirements for this app? For example:\n\n- What features should it have?\n- Who is the target audience?\n- What technologies do you prefer to use?\n- Any specific UI/UX preferences?",
      },
    ]);
  };

  const formatMarkdown = (text) => {
    if (!text) return "";

    // Handle code blocks
    text = text.replace(
      /```(\w+)?\n([\s\S]*?)```/g,
      '<pre class="code-block"><code>$2</code></pre>'
    );

    // Handle inline code
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Handle headers
    text = text.replace(/^### (.*$)/gm, "<h4>$1</h4>");
    text = text.replace(/^## (.*$)/gm, "<h3>$1</h3>");
    text = text.replace(/^# (.*$)/gm, "<h2>$1</h2>");

    // Handle lists
    text = text.replace(/^\* (.*$)/gm, "<li>$1</li>");
    text = text.replace(/^- (.*$)/gm, "<li>$1</li>");

    // Handle paragraphs
    text = text.replace(/\n\n/g, "</p><p>");

    // Wrap in paragraph if not already
    if (!text.startsWith("<h") && !text.startsWith("<p>")) {
      text = "<p>" + text + "</p>";
    }

    // Handle bold
    text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // Handle italic
    text = text.replace(/\*(.*?)\*/g, "<em>$1</em>");

    return text;
  };

  // Main App Component with Router
  return (
    <Router>
      <div className="app">
        {/* Speech recognition popup */}
        {showSpeechPopup && (
          <div className="speech-popup">
            <div className="speech-popup-header">
              {isListening ? "Listening..." : "Processing..."}
            </div>
            <div className="speech-transcript">
              {transcript || "Say something..."}
            </div>
            {isListening && (
              <div className="listening-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            )}
          </div>
        )}

        {/* Voice settings popup */}
        {showVoiceSettings && (
          <div className="voice-settings-popup">
            <div className="voice-settings-header">
              <h3>Voice Settings</h3>
              <button
                onClick={() => setShowVoiceSettings(false)}
                className="close-btn"
              >
                ×
              </button>
            </div>
            <div className="voice-settings-content">
              <div className="setting-group">
                <label>Language:</label>
                <select
                  value={voiceLanguage}
                  onChange={(e) => changeVoiceLanguage(e.target.value)}
                >
                  <option value="en-US">English (US)</option>
                  <option value="es-ES">Spanish</option>
                  <option value="fr-FR">French</option>
                  <option value="de-DE">German</option>
                  <option value="it-IT">Italian</option>
                  <option value="ja-JP">Japanese</option>
                  <option value="ko-KR">Korean</option>
                  <option value="zh-CN">Chinese (Simplified)</option>
                  <option value="ru-RU">Russian</option>
                  <option value="pt-BR">Portuguese (Brazil)</option>
                  <option value="hi-IN">Hindi</option>
                </select>
              </div>
              <div className="setting-group">
                <label>Voice:</label>
                <select
                  value={selectedVoice?.name || ""}
                  onChange={(e) => {
                    const voice = availableVoices.find(
                      (v) => v.name === e.target.value
                    );
                    setSelectedVoice(voice);
                  }}
                >
                  {availableVoices
                    .filter((voice) =>
                      voice.lang.includes(voiceLanguage.split("-")[0])
                    )
                    .map((voice) => (
                      <option key={voice.name} value={voice.name}>
                        {voice.name}
                      </option>
                    ))}
                </select>
              </div>
              <button
                onClick={() => setShowVoiceSettings(false)}
                className="save-settings-btn"
              >
                Save Settings
              </button>
            </div>
          </div>
        )}

        {/* New User Modal */}
        <div className={`new-user-modal ${isNewUserModalOpen ? "active" : ""}`}>
          <div className="modal-content">
            <div className="modal-header">
              <h2>Find Perfect GitHub Projects</h2>
              <button
                className="modal-close"
                onClick={() => setIsNewUserModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="search-options">
                <div>
                  <h3 className="option-title">What are you looking for?</h3>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newUserQuery.trim()) {
                        processNewUserQuery(newUserQuery);
                      }
                    }}
                  >
                    <div className="search-input-group">
                      <input
                        type="text"
                        placeholder="E.g., top python projects"
                        value={newUserQuery}
                        onChange={(e) => setNewUserQuery(e.target.value)}
                        className="search-input"
                      />
                      <button
                        type="submit"
                        className="send-button"
                        disabled={isProcessingNewUserQuery}
                      >
                        {isProcessingNewUserQuery ? "Searching..." : "Search"}
                      </button>
                    </div>
                  </form>
                  <div className="example-queries">
                    <h4>Try one of these:</h4>
                    <div className="query-pills">
                      <button
                        className="query-pill"
                        onClick={() =>
                          setNewUserQuery("top beginner python projects")
                        }
                      >
                        Beginner Python Projects
                      </button>
                      <button
                        className="query-pill"
                        onClick={() =>
                          setNewUserQuery("best React projects for learning")
                        }
                      >
                        React Learning Projects
                      </button>
                      <button
                        className="query-pill"
                        onClick={() =>
                          setNewUserQuery("data science portfolio projects")
                        }
                      >
                        Data Science Portfolio
                      </button>
                      <button
                        className="query-pill"
                        onClick={() =>
                          setNewUserQuery(
                            "game development projects with JavaScript"
                          )
                        }
                      >
                        JavaScript Games
                      </button>
                    </div>
                  </div>
                </div>
                <div className="or-divider">or</div>
                <div>
                  <button
                    className="voice-option-button"
                    onClick={toggleListening}
                  >
                    <span className="icon">🎙️</span> Ask by Voice
                  </button>
                  {transcript && (
                    <div className="transcript-container">
                      <div className="transcript-header">
                        <h4>
                          <span className="icon">🔊</span> I heard:
                        </h4>
                      </div>
                      <p className="transcript-text">{transcript}</p>
                    </div>
                  )}
                </div>
                {/* Project Recommendations */}
                {projectRecommendations.length > 0 && (
                  <div className="project-recommendations">
                    <div className="recommendation-header">
                      <h3>
                        <span className="icon">🚀</span> Recommended Projects
                      </h3>
                      <div className="recommendation-filters">
                        <button
                          className={`filter-button ${
                            activeFilter === "all" ? "active" : ""
                          }`}
                          onClick={() => setActiveFilter("all")}
                        >
                          All
                        </button>
                        <button
                          className={`filter-button ${
                            activeFilter === "beginner" ? "active" : ""
                          }`}
                          onClick={() => setActiveFilter("beginner")}
                        >
                          Beginner
                        </button>
                        <button
                          className={`filter-button ${
                            activeFilter === "intermediate" ? "active" : ""
                          }`}
                          onClick={() => setActiveFilter("intermediate")}
                        >
                          Intermediate
                        </button>
                        <button
                          className={`filter-button ${
                            activeFilter === "advanced" ? "active" : ""
                          }`}
                          onClick={() => setActiveFilter("advanced")}
                        >
                          Advanced
                        </button>
                      </div>
                    </div>
                    <div className="recommended-projects">
                      {projectRecommendations
                        .filter(
                          (project) =>
                            activeFilter === "all" ||
                            project.difficulty.toLowerCase() ===
                              activeFilter.toLowerCase()
                        )
                        .map((project, index) => (
                          <div className="recommended-project-card" key={index}>
                            <div className="project-card-header">
                              <h4>{project.name}</h4>
                            </div>
                            <div className="project-card-body">
                              <p className="project-description">
                                {project.description}
                              </p>
                              <div className="project-meta">
                                {project.classification?.map((tag, idx) => (
                                  <span className="project-meta-item" key={idx}>
                                    {tag}
                                  </span>
                                ))}
                                <span
                                  className={`project-meta-item difficulty ${project.difficulty.toLowerCase()}`}
                                >
                                  {project.difficulty}
                                </span>
                                <span className="project-meta-item">
                                  <span className="icon">⭐</span>{" "}
                                  {project.stars}
                                </span>
                              </div>
                            </div>
                            <div className="project-card-footer">
                              <button
                                className="explore-button"
                                onClick={() => {
                                  const urlParts = project.url
                                    .replace("https://github.com/", "")
                                    .split("/");
                                  const owner = urlParts[0];
                                  const repo = urlParts[1];
                                  handleProjectClick({
                                    name: repo,
                                    owner: { login: owner },
                                  });
                                  setIsNewUserModalOpen(false);
                                }}
                              >
                                <span className="icon">🔍</span> Explore
                              </button>
                              <a
                                href={project.url}
                                className="github-link"
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="icon">📂</span> GitHub
                              </a>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {isGithubView ? (
          // GitHub Repository View
          <div className="github-ui">
            <header className="github-header">
              <button onClick={backToHome} className="back-to-home-button">
                <span className="icon">🏠</span> Back
              </button>
              <div className="repo-title">
                <h2>{selectedProject?.name}</h2>
              </div>
              <div className="github-header-actions">
                <button
                  className="explain-codebase-button"
                  onClick={explainCodebase}
                  disabled={isExplainingCodebase}
                  title="Explain this codebase"
                >
                  <span className="icon">📚</span> Explain Codebase
                </button>
                <button
                  className="explain-purpose-button"
                  onClick={explainPurpose}
                  disabled={chatLoading}
                  title="Explain purpose of each file"
                >
                  <span className="icon">🔍</span> Explain Purpose
                </button>
                <button
                  className="generate-code-button"
                  onClick={generateCode}
                  disabled={isGeneratingCode}
                  title="Generate code for this project"
                >
                  <span className="icon">✨</span> Generate
                </button>
                <button className="voice-button" onClick={toggleListening}>
                  {isListening ? "🎙️" : "🎤"}
                </button>
                <button
                  className="settings-button"
                  onClick={() => setShowVoiceSettings(true)}
                >
                  ⚙️
                </button>
              </div>
            </header>
            <nav className="github-nav">
              <ul className="nav-tabs">
                <li className={currentTab === "code" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("code");
                    }}
                  >
                    <span className="icon">📁</span> Code
                  </button>
                </li>
                <li className={currentTab === "issues" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("issues");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "issues"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Analyze ${activeFile.name} for issues`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Analyze ${activeFile.name} from an issues perspective. Find potential bugs and issues.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">⚠️</span> Issues
                  </button>
                </li>
                <li className={currentTab === "pull" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("pull");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "pull"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Analyze ${activeFile.name} for pull requests`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Analyze ${activeFile.name} from a pull request perspective. Suggest code improvements.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">🔄</span> Pull requests
                  </button>
                </li>
                <li className={currentTab === "actions" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("actions");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "actions"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Analyze ${activeFile.name} for CI/CD actions`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Analyze ${activeFile.name} from a CI/CD perspective. Suggest workflow improvements.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">⚡</span> Actions
                  </button>
                </li>
                <li className={currentTab === "projects" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("projects");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "projects"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Analyze ${activeFile.name} for project management`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Analyze ${activeFile.name} from a project management perspective. Identify tasks and milestones.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">📊</span> Projects
                  </button>
                </li>
                <li className={currentTab === "wiki" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("wiki");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "wiki"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Generate documentation for ${activeFile.name}`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Generate documentation for ${activeFile.name} in a wiki-friendly format.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">📚</span> Wiki
                  </button>
                </li>
                <li className={currentTab === "security" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("security");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "security"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Analyze ${activeFile.name} for security vulnerabilities`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Analyze ${activeFile.name} for security vulnerabilities and suggest improvements.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">🔒</span> Security
                  </button>
                </li>
                <li className={currentTab === "insights" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("insights");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "insights"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Provide insights on ${activeFile.name}`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Provide deep insights and analytics on ${activeFile.name}.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">📈</span> Insights
                  </button>
                </li>
                <li className={currentTab === "settings" ? "active" : ""}>
                  <button
                    onClick={() => {
                      setCurrentTab("settings");
                      if (activeFile) {
                        setChatResponse("");
                        if (!useGroq) {
                          const response = getDefaultResponse(
                            activeFile.name,
                            "settings"
                          );
                          setChatHistory([
                            {
                              role: "user",
                              content: `Configure settings for ${activeFile.name}`,
                            },
                            { role: "assistant", content: response },
                          ]);
                          setChatResponse(response);
                        } else {
                          const tabPrompt = `Suggest configuration and settings best practices for ${activeFile.name}.`;
                          analyzeWithGroq(tabPrompt);
                        }
                      }
                    }}
                  >
                    <span className="icon">⚙️</span> Settings
                  </button>
                </li>
              </ul>
            </nav>
            <div className="github-content">
              <div className="file-explorer">
                <div className="file-explorer-header">
                  <h3>Files</h3>
                </div>
                <div className="file-explorer-nav">
                  <button onClick={backToProjectRoot} className="root-button">
                    <span className="icon">🏠</span> Root
                  </button>
                  <div className="breadcrumb">
                    {activeFile && (
                      <div className="file-path-breadcrumbs">
                        <span onClick={backToProjectRoot}>
                          {selectedProject.name}
                        </span>
                        {activeFile.path
                          ?.split("/")
                          .map((segment, index, array) => {
                            if (index === array.length - 1) {
                              return (
                                <span key={index} className="current">
                                  {segment}
                                </span>
                              );
                            }
                            return <span key={index}>{segment}</span>;
                          })}
                      </div>
                    )}
                  </div>
                </div>
                <ul className="files-list">
                  {projectFiles.map((file) => (
                    <li
                      key={file.sha}
                      className={
                        activeFile && activeFile.path === file.path
                          ? "active"
                          : ""
                      }
                      onClick={() => handleFileClick(file)}
                    >
                      {file.type === "dir" ? (
                        <span className="icon folder-icon">📁</span>
                      ) : (
                        <span className="icon file-icon">📄</span>
                      )}
                      <span className="file-name">{file.name}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="main-content">
                {currentTab === "code" ? (
                  <>
                    {activeFile ? (
                      <div className="file-view">
                        <div className="file-header">
                          <h3>
                            <span className="icon">📄</span> {activeFile.name}
                          </h3>
                          <div className="file-actions">
                            <button className="file-action-button">
                              <span className="icon">✏️</span> Edit
                            </button>
                            <button className="file-action-button">
                              <span className="icon">⬇️</span> Download
                            </button>
                          </div>
                        </div>
                        <div className="file-content">
                          {fileLoading ? (
                            <div className="loading-spinner">Loading...</div>
                          ) : fileLoadError ? (
                            <div className="file-load-error">
                              Failed to load file content. This could be due to
                              API limits or file permissions.
                            </div>
                          ) : (
                            <pre className="code-display">
                              <code>{fileContent}</code>
                            </pre>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="repo-overview">
                        <h3>Repository: {selectedProject?.name}</h3>
                        <p>{selectedProject?.description}</p>
                        <div className="files-overview">
                          <h4>Files in this repository:</h4>
                          <ul>
                            {projectFiles.map((file) => (
                              <li
                                key={file.sha}
                                onClick={() => handleFileClick(file)}
                              >
                                {file.type === "dir" ? (
                                  <span className="icon">📁</span>
                                ) : (
                                  <span className="icon">📄</span>
                                )}{" "}
                                {file.name}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="tab-content">
                    {chatLoading ? (
                      <div className="loading-spinner">
                        Loading {currentTab} data...
                      </div>
                    ) : (
                      <div className="groq-analysis">
                        <h3>
                          {currentTab.charAt(0).toUpperCase() +
                            currentTab.slice(1)}{" "}
                          Analysis
                        </h3>
                        {chatResponse && (
                          <div
                            className="analysis-content"
                            dangerouslySetInnerHTML={{
                              __html: formatMarkdown(chatResponse),
                            }}
                          ></div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div
                className={`groq-chatbot ${chatMinimized ? "minimized" : ""}`}
              >
                <div className="chatbot-header">
                  <h3>
                    <span className="icon">🤖</span> GitHub Copilot
                  </h3>
                  <button
                    onClick={() => setChatMinimized(!chatMinimized)}
                    className="minimize-button"
                  >
                    {chatMinimized ? "Expand" : "Minimize"}
                  </button>
                </div>

                {!chatMinimized && (
                  <div className="chatbot-content">
                    {chatHistory.length === 0 ? (
                      <div className="welcome-message">
                        <h4>Welcome to GitHub Copilot!</h4>
                        <p>
                          I can help you understand this codebase. Ask me
                          anything about the project or specific files.
                        </p>
                      </div>
                    ) : (
                      <div className="chat-messages">
                        {chatHistory.map((message, index) => (
                          <div
                            key={index}
                            className={`chat-message ${message.role}`}
                          >
                            <div
                              className="message-content"
                              dangerouslySetInnerHTML={{
                                __html: formatMarkdown(message.content),
                              }}
                            ></div>
                          </div>
                        ))}
                        {chatLoading && (
                          <div className="chat-loading">
                            <div className="loading-dots">
                              <span></span>
                              <span></span>
                              <span></span>
                            </div>
                            <p>Processing your request...</p>
                          </div>
                        )}
                      </div>
                    )}

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (userQuery.trim()) {
                          analyzeWithGroq();
                        }
                      }}
                      className="chat-form"
                    >
                      <input
                        type="text"
                        placeholder={
                          activeFile
                            ? `Ask about ${activeFile.name}...`
                            : "Ask about this project..."
                        }
                        value={userQuery}
                        onChange={(e) => setUserQuery(e.target.value)}
                        className="chat-input"
                      />
                      <button type="submit" className="send-button">
                        Send
                      </button>
                    </form>

                    <div className="chat-options">
                      <label className="toggle-option">
                        <input
                          type="checkbox"
                          checked={useGroq}
                          onChange={() => setUseGroq(!useGroq)}
                        />
                        Use Groq (uncheck for predefined responses)
                      </label>
                    </div>

                    {chatHistory.length === 0 && !chatLoading && (
                      <div className="quick-actions">
                        <button
                          className="action-button"
                          onClick={() => {
                            setUserQuery(
                              `What does ${
                                activeFile ? activeFile.name : "this project"
                              } do?`
                            );
                            analyzeWithGroq();
                          }}
                        >
                          <span className="icon">📋</span> Explain purpose
                        </button>
                        <button
                          className="action-button"
                          onClick={() => {
                            setUserQuery(
                              `Find bugs in ${
                                activeFile ? activeFile.name : "this codebase"
                              }`
                            );
                            analyzeWithGroq();
                          }}
                        >
                          <span className="icon">🐛</span> Find bugs
                        </button>
                        <button
                          className="action-button"
                          onClick={() => {
                            setUserQuery(
                              `Suggest code improvements for ${
                                activeFile ? activeFile.name : "this project"
                              }`
                            );
                            analyzeWithGroq();
                          }}
                        >
                          <span className="icon">💡</span> Suggest improvements
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Enhanced Feature Popups */}
            {showExplainCodebasePopup && (
              <div className="feature-popup codebase-popup">
                <div className="popup-content">
                  <div className="popup-header">
                    <h2>📚 Codebase Explanation</h2>
                    <button
                      className="close-btn"
                      onClick={() => setShowExplainCodebasePopup(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="popup-body">
                    {isAnalyzingCodebase ? (
                      <div className="analyzing-codebase">
                        <div className="spinner"></div>
                        <p>Analyzing codebase structure and organization...</p>
                      </div>
                    ) : (
                      <>
                        <div className="ratings-section">
                          <h3>Codebase Rating</h3>
                          <div className="ratings-grid">
                            <div className="rating-item">
                              <span className="rating-label">
                                Codebase Quality:
                              </span>
                              <div className="rating-bar">
                                <div
                                  className="rating-fill"
                                  style={{
                                    width: `${codebaseRatings.codebase * 10}%`,
                                  }}
                                ></div>
                              </div>
                              <span className="rating-value">
                                {codebaseRatings.codebase}/10
                              </span>
                            </div>
                            <div className="rating-item">
                              <span className="rating-label">Navigation:</span>
                              <div className="rating-bar">
                                <div
                                  className="rating-fill"
                                  style={{
                                    width: `${
                                      codebaseRatings.navigation * 10
                                    }%`,
                                  }}
                                ></div>
                              </div>
                              <span className="rating-value">
                                {codebaseRatings.navigation}/10
                              </span>
                            </div>
                            <div className="rating-item">
                              <span className="rating-label">
                                Use Case Clarity:
                              </span>
                              <div className="rating-bar">
                                <div
                                  className="rating-fill"
                                  style={{
                                    width: `${codebaseRatings.useCase * 10}%`,
                                  }}
                                ></div>
                              </div>
                              <span className="rating-value">
                                {codebaseRatings.useCase}/10
                              </span>
                            </div>
                            <div className="rating-item">
                              <span className="rating-label">
                                Compatibility:
                              </span>
                              <div className="rating-bar">
                                <div
                                  className="rating-fill"
                                  style={{
                                    width: `${
                                      codebaseRatings.compatibility * 10
                                    }%`,
                                  }}
                                ></div>
                              </div>
                              <span className="rating-value">
                                {codebaseRatings.compatibility}/10
                              </span>
                            </div>
                            <div className="rating-item">
                              <span className="rating-label">
                                Runtime Performance:
                              </span>
                              <div className="rating-bar">
                                <div
                                  className="rating-fill"
                                  style={{
                                    width: `${codebaseRatings.runtime * 10}%`,
                                  }}
                                ></div>
                              </div>
                              <span className="rating-value">
                                {codebaseRatings.runtime}/10
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="explanation-container">
                          <h3>Structure Analysis</h3>
                          <div
                            className="explanation-content"
                            dangerouslySetInnerHTML={{
                              __html: formatMarkdown(codebaseExplanation),
                            }}
                          ></div>
                        </div>
                        <div className="voice-actions">
                          <button
                            onClick={() => speakResponse(codebaseExplanation)}
                            className="voice-button"
                          >
                            <span className="icon">🔊</span> Listen to
                            Explanation
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showExplainPurposePopup && (
              <div className="feature-popup purpose-popup">
                <div className="popup-content">
                  <div className="popup-header">
                    <h2>🔍 Project Purpose & Business Model</h2>
                    <button
                      className="close-btn"
                      onClick={() => setShowExplainPurposePopup(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="popup-body">
                    <div className="purpose-explanation">
                      <div
                        className="explanation-content"
                        dangerouslySetInnerHTML={{
                          __html: formatMarkdown(purposeExplanation),
                        }}
                      ></div>
                    </div>
                    <div className="purpose-chat">
                      <h3>Ask About Business Model</h3>
                      <div className="chat-messages">
                        {purposeChatHistory.map((message, index) => (
                          <div
                            key={index}
                            className={`chat-message ${message.role}`}
                          >
                            <div
                              className="message-content"
                              dangerouslySetInnerHTML={{
                                __html: formatMarkdown(message.content),
                              }}
                            ></div>
                          </div>
                        ))}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!purposeChatInput.trim()) return;

                          // Add user message to chat
                          setPurposeChatHistory([
                            ...purposeChatHistory,
                            { role: "user", content: purposeChatInput },
                          ]);

                          // Store and clear input
                          const query = purposeChatInput;
                          setPurposeChatInput("");

                          // Process with optimal model
                          const taskContext = {
                            taskType: "business-analysis",
                            prompt: query,
                          };
                          const model =
                            selectOptimalModel(taskContext) || AI_MODELS.GPT4;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert business and product analyst for software projects. You're discussing the business model, use cases, and potential improvements for ${
                                      selectedProject?.name || "this project"
                                    }.`,
                                  },
                                  ...purposeChatHistory.map((msg) => ({
                                    role: msg.role,
                                    content: msg.content,
                                  })),
                                  {
                                    role: "user",
                                    content: query,
                                  },
                                ],
                                temperature: 0.3,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const assistantResponse =
                                response.data.choices[0].message.content;
                              setPurposeChatHistory((prev) => [
                                ...prev,
                                {
                                  role: "assistant",
                                  content: assistantResponse,
                                },
                              ]);
                            })
                            .catch((error) => {
                              console.error("Purpose chat error:", error);
                              setPurposeChatHistory((prev) => [
                                ...prev,
                                {
                                  role: "assistant",
                                  content:
                                    "I'm sorry, I encountered an error processing your request. Please try again.",
                                },
                              ]);
                            });
                        }}
                        className="chat-input-form"
                      >
                        <input
                          type="text"
                          placeholder="Ask about business model, features, or target users..."
                          value={purposeChatInput}
                          onChange={(e) => setPurposeChatInput(e.target.value)}
                          className="chat-input"
                        />
                        <button type="submit">
                          <span className="icon">💬</span>
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {showGenerateCodePopup && (
              <div className="feature-popup generate-popup">
                <div className="popup-content">
                  <div className="popup-header">
                    <h2>✨ AI Code Generation</h2>
                    <button
                      className="close-btn"
                      onClick={() => setShowGenerateCodePopup(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="popup-body">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        processGenerationPrompt();
                      }}
                      className="generation-form"
                    >
                      <div className="input-group">
                        <label htmlFor="generationPrompt">
                          What would you like to generate?
                        </label>
                        <textarea
                          id="generationPrompt"
                          placeholder="E.g., Generate a responsive navigation component with dark mode toggle"
                          value={generationPrompt}
                          onChange={(e) => setGenerationPrompt(e.target.value)}
                          rows={4}
                        ></textarea>
                      </div>
                      <button
                        type="submit"
                        className="generate-button"
                        disabled={isLoadingGeneration}
                      >
                        {isLoadingGeneration
                          ? "Generating..."
                          : "Generate Code"}
                      </button>
                    </form>

                    {isLoadingGeneration && (
                      <div className="loading-indicator">
                        <div className="spinner"></div>
                        <p>
                          Generating high-quality code based on your
                          requirements...
                        </p>
                      </div>
                    )}

                    {generationResult && (
                      <div className="generation-result">
                        <h3>Generated Code</h3>
                        <div
                          className="result-content"
                          dangerouslySetInnerHTML={{
                            __html: formatMarkdown(generationResult),
                          }}
                        ></div>
                        <div className="result-actions">
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(generationResult);
                              alert("Code copied to clipboard!");
                            }}
                            className="copy-button"
                          >
                            <span className="icon">📋</span> Copy to Clipboard
                          </button>
                          <button
                            onClick={() => {
                              setShowDeploymentModal(true);
                            }}
                            className="deploy-button"
                          >
                            <span className="icon">🚀</span> Deploy to GitHub
                          </button>
                          <button
                            onClick={() => {
                              setShowPullDeployModal(true);
                            }}
                            className="pull-deploy-button"
                          >
                            <span className="icon">🔄</span> Pull & Deploy
                          </button>
                          <button
                            onClick={() => {
                              // Handle integration with current file
                              setIsIntegrating(true);
                              setIntegrationError(null);

                              if (!activeFile) {
                                setIsIntegrating(false);
                                alert("Please select a file first");
                                return;
                              }

                              // Extract code from result
                              const codeBlockMatch = generationResult.match(
                                /```(?:\w+)?\n([\s\S]*?)```/
                              );
                              if (!codeBlockMatch || !codeBlockMatch[1]) {
                                setIsIntegrating(false);
                                alert(
                                  "Could not extract code from the generation result"
                                );
                                return;
                              }

                              const extractedCode = codeBlockMatch[1].trim();

                              // Use AI to merge with current file
                              const taskContext = {
                                taskType: "code-integration",
                                fileType: activeFile.name.split(".").pop(),
                                prompt: "Merge code",
                              };

                              const modelToUse =
                                selectOptimalModel(taskContext) ||
                                AI_MODELS.LLAMA;

                              axios
                                .post(
                                  "https://api.groq.com/openai/v1/chat/completions",
                                  {
                                    model: modelToUse,
                                    messages: [
                                      {
                                        role: "system",
                                        content: `You are an expert code integrator. You need to intelligently merge newly generated code into existing code.
                                      Ensure the result is coherent, functional, and follows best practices. Resolve any conflicts, eliminate redundancies,
                                      and maintain the structure and intent of both code bases. Your output should be ONLY the merged code, nothing else.`,
                                      },
                                      {
                                        role: "user",
                                        content: `Here is the existing code in ${activeFile.name}:\n\n${fileContent}\n\nHere is the new code to integrate:\n\n${extractedCode}\n\nMerge these intelligently into a single coherent file.`,
                                      },
                                    ],
                                    temperature: 0.1,
                                    max_tokens: 4000,
                                  },
                                  {
                                    headers: {
                                      Authorization: `Bearer ${GROQ_API_KEY}`,
                                      "Content-Type": "application/json",
                                    },
                                  }
                                )
                                .then((response) => {
                                  const mergedCode =
                                    response.data.choices[0].message.content;
                                  setFileContent(mergedCode);
                                  setIntegrationComplete(true);
                                  setChatHistory([
                                    ...chatHistory,
                                    {
                                      role: "assistant",
                                      content:
                                        "✅ Successfully integrated generated code into the existing file.",
                                    },
                                  ]);
                                })
                                .catch((error) => {
                                  console.error("Integration error:", error);
                                  setIntegrationError(
                                    error.message || "Unknown error"
                                  );
                                  setIsIntegrating(false);
                                })
                                .finally(() => {
                                  setIsIntegrating(false);
                                });
                            }}
                            className="integrate-button"
                            disabled={isIntegrating}
                          >
                            <span className="icon">🧩</span>
                            {isIntegrating
                              ? "Integrating..."
                              : "Integrate with Current File"}
                          </button>
                        </div>

                        {integrationComplete && (
                          <div className="integration-success">
                            <p>
                              ✅ Code successfully integrated with the current
                              file!
                            </p>
                          </div>
                        )}
                        {integrationError && (
                          <div className="integration-error">
                            <p>❌ Integration error: {integrationError}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Deployment Modal */}
            {showDeploymentModal && (
              <div className="deployment-modal">
                <div className="deployment-content">
                  <div className="deployment-header">
                    <h3>Deploy to GitHub</h3>
                    <button
                      className="close-btn"
                      onClick={() => {
                        setShowDeploymentModal(false);
                        setDeploymentComplete(false);
                        setDeploymentError(null);
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <div className="deployment-body">
                    <div className="input-group">
                      <label htmlFor="customRepoName">
                        Repository Name (optional):
                      </label>
                      <input
                        type="text"
                        id="customRepoName"
                        value={customRepoName}
                        onChange={(e) => setCustomRepoName(e.target.value)}
                        placeholder="Enter repository name"
                        className="modal-input"
                      />
                    </div>

                    {deploymentError && (
                      <div className="deployment-error">
                        <p>Error: {deploymentError}</p>
                      </div>
                    )}

                    {deploymentComplete ? (
                      <div className="deployment-success">
                        <h4>🎉 Deployment Successful!</h4>
                        <p>Your code has been deployed to GitHub.</p>
                        <a
                          href={`https://github.com/${githubRepoOwner}/${githubRepoName}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="view-repo-button"
                        >
                          <span className="icon">🔗</span> View Repository
                        </a>
                      </div>
                    ) : (
                      <div className="deployment-actions">
                        <button
                          onClick={() => {
                            setIsDeploying(true);
                            setDeploymentError(null);

                            // Extract code from the generation result
                            const codeBlockMatch = generationResult.match(
                              /```(?:\w+)?\n([\s\S]*?)```/
                            );
                            if (!codeBlockMatch || !codeBlockMatch[1]) {
                              setIsDeploying(false);
                              setDeploymentError(
                                "Could not extract code from the generation result"
                              );
                              return;
                            }

                            const code = codeBlockMatch[1].trim();

                            // Create a timestamp-based repo name
                            const timestamp = new Date()
                              .getTime()
                              .toString()
                              .slice(-6);
                            const repoName = customRepoName
                              ? `${customRepoName.replace(
                                  /[^a-zA-Z0-9-_]/g,
                                  "-"
                                )}-${timestamp}`
                              : `generated-code-${timestamp}`;

                            // Check if token is valid
                            fetch("https://api.github.com/user", {
                              headers: {
                                Authorization: `token ${GITHUB_API_KEY}`,
                                Accept: "application/vnd.github.v3+json",
                              },
                            })
                              .then((response) => {
                                if (!response.ok)
                                  throw new Error(
                                    "GitHub token validation failed"
                                  );
                                return response.json();
                              })
                              .then((userData) => {
                                // Create repository
                                return fetch(
                                  "https://api.github.com/user/repos",
                                  {
                                    method: "POST",
                                    headers: {
                                      Authorization: `token ${GITHUB_API_KEY}`,
                                      Accept: "application/vnd.github.v3+json",
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      name: repoName,
                                      auto_init: true,
                                      private: false,
                                      description: "Generated code from ORCA",
                                    }),
                                  }
                                )
                                  .then((response) => {
                                    if (!response.ok)
                                      throw new Error(
                                        "Failed to create repository"
                                      );
                                    return response.json();
                                  })
                                  .then((repoData) => {
                                    // Repository created, now wait a bit for GitHub to initialize it
                                    return new Promise((resolve) =>
                                      setTimeout(() => resolve(repoData), 2000)
                                    );
                                  })
                                  .then((repoData) => {
                                    // Create files
                                    const fileName = activeFile
                                      ? activeFile.name.replace(
                                          /\.\w+$/,
                                          `-enhanced.${getFileExtension()}`
                                        )
                                      : `generated-code.${getFileExtension()}`;

                                    // Add code file
                                    const encodedContent = btoa(
                                      unescape(encodeURIComponent(code))
                                    );
                                    return fetch(
                                      `https://api.github.com/repos/${repoData.owner.login}/${repoData.name}/contents/${fileName}`,
                                      {
                                        method: "PUT",
                                        headers: {
                                          Authorization: `token ${GITHUB_API_KEY}`,
                                          Accept:
                                            "application/vnd.github.v3+json",
                                          "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                          message: "Add generated code",
                                          content: encodedContent,
                                        }),
                                      }
                                    )
                                      .then((response) => {
                                        if (!response.ok)
                                          throw new Error(
                                            "Failed to upload code file"
                                          );

                                        // Add README
                                        const readmeContent = `# Generated Code\n\n## Description\nThis code was generated using ORCA's AI-powered code generator based on the prompt:\n\`\`\`\n${generationPrompt}\n\`\`\``;
                                        const encodedReadme = btoa(
                                          unescape(
                                            encodeURIComponent(readmeContent)
                                          )
                                        );

                                        return fetch(
                                          `https://api.github.com/repos/${repoData.owner.login}/${repoData.name}/contents/README.md`,
                                          {
                                            method: "PUT",
                                            headers: {
                                              Authorization: `token ${GITHUB_API_KEY}`,
                                              Accept:
                                                "application/vnd.github.v3+json",
                                              "Content-Type":
                                                "application/json",
                                            },
                                            body: JSON.stringify({
                                              message: "Add README",
                                              content: encodedReadme,
                                            }),
                                          }
                                        );
                                      })
                                      .then((response) => {
                                        if (!response.ok)
                                          throw new Error(
                                            "Failed to upload README"
                                          );

                                        setGithubRepoName(repoData.name);
                                        setGithubRepoOwner(
                                          repoData.owner.login
                                        );
                                        setDeploymentComplete(true);

                                        // Add success message to chat
                                        setChatHistory([
                                          ...chatHistory,
                                          {
                                            role: "assistant",
                                            content: `I've deployed the generated code to GitHub! Repository: https://github.com/${repoData.owner.login}/${repoData.name}`,
                                          },
                                        ]);
                                      });
                                  });
                              })
                              .catch((error) => {
                                console.error("Deployment error:", error);
                                setDeploymentError(
                                  error.message || "Error deploying to GitHub"
                                );
                              })
                              .finally(() => {
                                setIsDeploying(false);
                              });
                          }}
                          className="deploy-button"
                          disabled={isDeploying}
                        >
                          {isDeploying ? (
                            <>
                              <span className="spinner"></span>
                              Deploying...
                            </>
                          ) : (
                            <>
                              <span className="icon">🚀</span> Deploy to GitHub
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Pull and Deploy Modal */}
            {showPullDeployModal && (
              <div className="deployment-modal">
                <div className="deployment-content">
                  <div className="deployment-header">
                    <h3>Pull & Deploy to Existing Repository</h3>
                    <button
                      className="close-btn"
                      onClick={() => {
                        setShowPullDeployModal(false);
                        setPullDeployComplete(false);
                        setPullDeployError(null);
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <div className="deployment-body">
                    <div className="input-group">
                      <label htmlFor="targetRepoOwner">
                        Repository Owner (username):
                      </label>
                      <input
                        type="text"
                        id="targetRepoOwner"
                        value={targetRepoOwner}
                        onChange={(e) => setTargetRepoOwner(e.target.value)}
                        placeholder="Enter GitHub username"
                        required
                        className="modal-input"
                      />
                    </div>

                    <div className="input-group">
                      <label htmlFor="targetRepoName">Repository Name:</label>
                      <input
                        type="text"
                        id="targetRepoName"
                        value={targetRepoName}
                        onChange={(e) => setTargetRepoName(e.target.value)}
                        placeholder="Enter repository name"
                        required
                        className="modal-input"
                      />
                    </div>

                    {pullDeployError && (
                      <div className="deployment-error">
                        <p>Error: {pullDeployError}</p>
                      </div>
                    )}

                    {pullDeployComplete ? (
                      <div className="deployment-success">
                        <h4>🎉 Pull & Deploy Successful!</h4>
                        <p>
                          Your code has been combined with the existing
                          repository code and deployed.
                        </p>
                        <a
                          href={`https://github.com/${targetRepoOwner}/${targetRepoName}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="view-repo-button"
                        >
                          <span className="icon">🔗</span> View Repository
                        </a>
                      </div>
                    ) : (
                      <div className="deployment-actions">
                        <button
                          className="deploy-button"
                          onClick={() => {
                            if (!targetRepoOwner || !targetRepoName) {
                              setPullDeployError(
                                "Please enter both repository owner and name"
                              );
                              return;
                            }

                            setIsPullDeploying(true);
                            setPullDeployError(null);

                            // Begin pull & deploy process
                            // First, extract code from the generation result
                            const codeBlockMatch = generationResult.match(
                              /```(?:\w+)?\n([\s\S]*?)```/
                            );
                            if (!codeBlockMatch || !codeBlockMatch[1]) {
                              setIsPullDeploying(false);
                              setPullDeployError(
                                "Could not extract code from the generation result"
                              );
                              return;
                            }

                            const code = codeBlockMatch[1].trim();

                            // Verify repository exists and we have access
                            fetch(
                              `https://api.github.com/repos/${targetRepoOwner}/${targetRepoName}`,
                              {
                                headers: {
                                  Authorization: `token ${GITHUB_API_KEY}`,
                                  Accept: "application/vnd.github.v3+json",
                                },
                              }
                            )
                              .then((response) => {
                                if (!response.ok)
                                  throw new Error(
                                    "Repository not found or access denied"
                                  );
                                return response.json();
                              })
                              .then((repoData) => {
                                // Generate a filename for the code
                                const fileName = `generated-${Date.now()}.${getFileExtension()}`;

                                // Add the generated code file
                                const encodedContent = btoa(
                                  unescape(encodeURIComponent(code))
                                );
                                return fetch(
                                  `https://api.github.com/repos/${targetRepoOwner}/${targetRepoName}/contents/${fileName}`,
                                  {
                                    method: "PUT",
                                    headers: {
                                      Authorization: `token ${GITHUB_API_KEY}`,
                                      Accept: "application/vnd.github.v3+json",
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      message: "Add AI-generated code",
                                      content: encodedContent,
                                    }),
                                  }
                                );
                              })
                              .then((response) => {
                                if (!response.ok)
                                  throw new Error(
                                    "Failed to add file to repository"
                                  );
                                return response.json();
                              })
                              .then(() => {
                                setPullDeployComplete(true);

                                // Add success message to chat
                                setChatHistory([
                                  ...chatHistory,
                                  {
                                    role: "assistant",
                                    content: `I've successfully added the generated code to the repository: https://github.com/${targetRepoOwner}/${targetRepoName}`,
                                  },
                                ]);
                              })
                              .catch((error) => {
                                console.error("Pull & Deploy error:", error);
                                setPullDeployError(
                                  error.message || "Error deploying to GitHub"
                                );
                              })
                              .finally(() => {
                                setIsPullDeploying(false);
                              });
                          }}
                          disabled={
                            isPullDeploying ||
                            !targetRepoOwner ||
                            !targetRepoName
                          }
                        >
                          {isPullDeploying ? (
                            <>
                              <span className="spinner"></span>
                              Pulling & Deploying...
                            </>
                          ) : (
                            <>
                              <span className="icon">🚀</span> Pull & Deploy
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : isAppCreatorOpen ? (
          // App Creator View
          <div className="app-creator">
            <header className="app-creator-header">
              <button onClick={backToHome} className="back-to-home-button">
                <span className="icon">🏠</span> Back
              </button>
              <div className="app-title">
                <h2>{getProgrammingLanguageName()} App Creator</h2>
              </div>
              <div className="app-creator-actions">
                {appGenerationStep === "complete" && (
                  <>
                    <button
                      onClick={() => {
                        setIsGeneratingPreview(true);
                        setPreviewError(null);

                        // Get selected files for preview content
                        const filesToPreview = generatedAppFiles
                          .slice(0, 5)
                          .map(
                            (file) =>
                              `--- ${file.path}${
                                file.name
                              } ---\n${file.content.substring(0, 1000)}${
                                file.content.length > 1000 ? "..." : ""
                              }\n\n`
                          )
                          .join("");

                        // Determine optimal model for UI preview
                        const modelToUse = AI_MODELS.CLAUDE; // Use Claude for visual tasks

                        axios
                          .post(
                            "https://api.groq.com/openai/v1/chat/completions",
                            {
                              model: modelToUse,
                              messages: [
                                {
                                  role: "system",
                                  content: `You are an expert at converting ${getProgrammingLanguageName()} code into runnable HTML preview. Your task is to create a complete HTML page that demonstrates the functionality of the ${getProgrammingLanguageName()} application described in the files provided.
                                
                                When creating the preview:
                                1. Include all necessary CSS, JavaScript, and HTML
                                2. Create a fully responsive design that works on all devices
                                3. Use modern CSS features (flexbox/grid, variables, etc.)
                                4. Implement proper event handling and interactivity
                                5. Add accessibility features (ARIA, semantic HTML, etc.)
                                6. Ensure the preview shows realistic data and functionality
                                7. Optimize for performance and loading speed
                                8. Implement proper error handling and validation
                                9. Include all main app features in the preview
                                10. Add UI state management (active states, hover effects, etc.)
                                
                                Only return valid HTML code that can be directly injected into an iframe. No explanations or markdown.`,
                                },
                                {
                                  role: "user",
                                  content: `Create a preview HTML page for this ${getProgrammingLanguageName()} application. Here are some of the main files: ${filesToPreview}
                                
                                Create a complete, self-contained HTML page that demonstrates how this app would look and function. The HTML should include all necessary CSS and JavaScript inline. If the application is not web-based (like Python, Java, etc.), create a simulation/mockup of how the UI would look based on the code logic.
                                
                                Create a visually appealing, professional UI with:
                                - Proper responsive design for all screen sizes
                                - Clean typography and spacing
                                - Consistent color scheme
                                - Modern UI components
                                - Professional layout with proper alignment
                                
                                DO NOT include any explanations, ONLY return valid HTML code.`,
                                },
                              ],
                              temperature: 0.2,
                              max_tokens: 8000,
                            },
                            {
                              headers: {
                                Authorization: `Bearer ${GROQ_API_KEY}`,
                                "Content-Type": "application/json",
                              },
                            }
                          )
                          .then((response) => {
                            const htmlContent =
                              response.data.choices[0].message.content.trim();
                            // Clean up any markdown code blocks if present
                            const cleanHtml = htmlContent.replace(
                              /```html\n|\n```|```/g,
                              ""
                            );
                            setPreviewHtml(cleanHtml);
                            setShowPreview(true);
                          })
                          .catch((error) => {
                            console.error("Error generating preview:", error);
                            setPreviewError(
                              "Failed to generate preview. Please try again."
                            );
                          })
                          .finally(() => {
                            setIsGeneratingPreview(false);
                          });
                      }}
                      className="preview-button"
                      disabled={isGeneratingPreview}
                    >
                      <span className="icon">👁️</span>{" "}
                      {isGeneratingPreview ? "Generating..." : "Preview"}
                    </button>
                    <button
                      onClick={() => {
                        // Create a zip file with the app content
                        alert(
                          "Download functionality would be implemented here"
                        );
                      }}
                      className="download-button"
                    >
                      <span className="icon">⬇️</span> Download
                    </button>
                    <button
                      onClick={() => setShowDeploymentModal(true)}
                      className="deploy-button"
                      disabled={isDeploying}
                    >
                      {isDeploying ? (
                        <>
                          <span className="spinner"></span>
                          Deploying...
                        </>
                      ) : (
                        <>
                          <span className="icon">🚀</span> Deploy to GitHub
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>
            </header>

            <div className="app-creator-content">
              <div className="app-creator-sidebar">
                {/* Language selection section */}
                {appGenerationStep === "initial" && (
                  <div className="language-selector">
                    <div className="language-options">
                      {[
                        { id: "react", name: "React", icon: "⚛️" },
                        { id: "python", name: "Python", icon: "🐍" },
                        { id: "java", name: "Java", icon: "☕" },
                        { id: "node", name: "Node.js", icon: "🟢" },
                        { id: "flutter", name: "Flutter", icon: "📱" },
                        { id: "angular", name: "Angular", icon: "🅰️" },
                        { id: "vue", name: "Vue.js", icon: "🟩" },
                        { id: "csharp", name: "C#", icon: "🔷" },
                        { id: "ruby", name: "Ruby", icon: "💎" },
                        { id: "php", name: "PHP", icon: "🐘" },
                      ].map((lang) => (
                        <div
                          key={lang.id}
                          className={`language-option ${
                            selectedProgrammingLanguage === lang.id
                              ? "selected"
                              : ""
                          }`}
                          onClick={() => handleLanguageChange(lang.id)}
                        >
                          <span className="lang-icon">{lang.icon}</span>
                          <span className="lang-name">{lang.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="app-creator-files">
                  <h3>Files</h3>
                  <ul className="app-file-list">
                    {appCreatorFiles.map((file) => (
                      <li
                        key={file.id}
                        className={
                          activeAppFile && activeAppFile.id === file.id
                            ? "active"
                            : ""
                        }
                        onClick={() => {
                          setActiveAppFile(file);
                          if (file.type === "file") {
                            setCodeEditorContent(file.content || "");
                          }
                        }}
                      >
                        {file.type === "dir" ? (
                          <span className="icon folder-icon">📁</span>
                        ) : (
                          <span className="icon file-icon">📄</span>
                        )}
                        <span className="file-name">{file.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="ai-helpers">
                  <h3>AI Coding Helpers</h3>
                  <ul className="helper-list">
                    <li>
                      <button
                        className="helper-button"
                        onClick={() => {
                          setIsAiHelperProcessing(true);

                          if (!activeAppFile || !codeEditorContent) {
                            alert("Please select a file with code to debug");
                            setIsAiHelperProcessing(false);
                            return;
                          }

                          setAppCreatorChatHistory([
                            ...appCreatorChatHistory,
                            {
                              role: "user",
                              content: `Debug the code in ${activeAppFile.name}`,
                            },
                            {
                              role: "assistant",
                              content: "Analyzing code for bugs and issues...",
                            },
                          ]);

                          // Determine optimal model
                          const taskContext = {
                            taskType: "debug-code",
                            fileType: activeAppFile.name.split(".").pop(),
                            prompt: "Debug code",
                          };

                          const modelToUse =
                            selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model: modelToUse,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert code debugger. Find and fix issues in the provided code.
                                  When debugging:
                                  1. Identify actual bugs and logic errors (not just style issues)
                                  2. Provide specific line numbers where problems occur
                                  3. Explain each issue clearly with reasoning
                                  4. Provide fixed code snippets for each issue
                                  5. Consider edge cases and potential runtime errors
                                  6. Verify that your fixes maintain code functionality
                                  7. Ensure fixes follow modern best practices
                                  
                                  Format your response with clear sections and code blocks.
                                  Each issue should have: Description, Impact, Fix (with before/after code), and Explanation.`,
                                  },
                                  {
                                    role: "user",
                                    content: `Debug this code from ${activeAppFile.name}:\n\n${codeEditorContent}`,
                                  },
                                ],
                                temperature: 0.1,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const debugResult =
                                response.data.choices[0].message.content;

                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Debug the code in ${activeAppFile.name}`,
                                },
                                { role: "assistant", content: debugResult },
                              ]);

                              speakResponse(
                                "I've debugged your code and found some issues. Check the chat for details."
                              );
                            })
                            .catch((error) => {
                              console.error("Error debugging code:", error);
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Debug the code in ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content:
                                    "Sorry, I encountered an error while debugging your code. Please try again.",
                                },
                              ]);
                            })
                            .finally(() => {
                              setIsAiHelperProcessing(false);
                            });
                        }}
                        disabled={isAiHelperProcessing || !activeAppFile}
                      >
                        <span className="icon">🐛</span> Debug Code
                      </button>
                    </li>
                    <li>
                      <button
                        className="helper-button"
                        onClick={() => {
                          setIsAiHelperProcessing(true);

                          if (!activeAppFile || !codeEditorContent) {
                            alert("Please select a file with code to explain");
                            setIsAiHelperProcessing(false);
                            return;
                          }

                          setAppCreatorChatHistory([
                            ...appCreatorChatHistory,
                            {
                              role: "user",
                              content: `Explain the code in ${activeAppFile.name}`,
                            },
                            {
                              role: "assistant",
                              content:
                                "Analyzing code structure and functionality...",
                            },
                          ]);

                          // Determine optimal model
                          const taskContext = {
                            taskType: "code-explanation",
                            fileType: activeAppFile.name.split(".").pop(),
                            prompt: "Explain code",
                          };

                          const modelToUse =
                            selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model: modelToUse,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert code explainer. Provide a clear, detailed explanation of the provided code.
                                  Structure your explanation with:
                                  1. High-level overview of what the code does
                                  2. Breakdown of key components/functions with their purpose
                                  3. Data flow and control flow explanation
                                  4. How different parts interact
                                  5. Any patterns or important concepts used
                                  
                                  Make the explanation educational and thorough, with appropriate detail for each section.
                                  Use clear headings, bullet points, and code references to make the explanation easy to follow.`,
                                  },
                                  {
                                    role: "user",
                                    content: `Explain this code from ${activeAppFile.name} in detail:\n\n${codeEditorContent}`,
                                  },
                                ],
                                temperature: 0.2,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const explainResult =
                                response.data.choices[0].message.content;

                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Explain the code in ${activeAppFile.name}`,
                                },
                                { role: "assistant", content: explainResult },
                              ]);

                              speakResponse(
                                "I've analyzed your code and prepared an explanation. Check the chat for details."
                              );
                            })
                            .catch((error) => {
                              console.error("Error explaining code:", error);
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Explain the code in ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content:
                                    "Sorry, I encountered an error while explaining your code. Please try again.",
                                },
                              ]);
                            })
                            .finally(() => {
                              setIsAiHelperProcessing(false);
                            });
                        }}
                        disabled={isAiHelperProcessing || !activeAppFile}
                      >
                        <span className="icon">🔍</span> Explain Code
                      </button>
                    </li>
                    <li>
                      <button
                        className="helper-button"
                        onClick={() => {
                          setIsAiHelperProcessing(true);

                          if (!activeAppFile || !codeEditorContent) {
                            alert("Please select a file with code to optimize");
                            setIsAiHelperProcessing(false);
                            return;
                          }

                          setAppCreatorChatHistory([
                            ...appCreatorChatHistory,
                            {
                              role: "user",
                              content: `Optimize the code in ${activeAppFile.name}`,
                            },
                            {
                              role: "assistant",
                              content:
                                "Analyzing code for optimization opportunities...",
                            },
                          ]);

                          // Determine optimal model
                          const taskContext = {
                            taskType: "optimize-code",
                            fileType: activeAppFile.name.split(".").pop(),
                            prompt: "Optimize code",
                          };

                          const modelToUse =
                            selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model: modelToUse,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert performance engineer. Optimize the provided code for speed, memory usage, and overall efficiency.
                                  Focus on:
                                  1. Algorithmic improvements
                                  2. Memory usage optimization
                                  3. Reducing computational complexity
                                  4. Appropriate caching strategies
                                  5. Asynchronous processing where beneficial
                                  6. Resource management improvements
                                  
                                  Provide before/after comparisons for significant changes, and explain your optimization rationale.
                                  Return the completely optimized code wrapped in a code block.`,
                                  },
                                  {
                                    role: "user",
                                    content: `Optimize this code from ${activeAppFile.name}:\n\n${codeEditorContent}\n\nProvide the optimized version and explain your improvements.`,
                                  },
                                ],
                                temperature: 0.1,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const optimizeResult =
                                response.data.choices[0].message.content;

                              // Update chat with explanation
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Optimize the code in ${activeAppFile.name}`,
                                },
                                { role: "assistant", content: optimizeResult },
                              ]);

                              // Extract code to update the editor
                              const codeBlockMatch = optimizeResult.match(
                                /```(?:jsx?|tsx?|javascript|typescript)?\n([\s\S]*?)```/
                              );
                              if (codeBlockMatch && codeBlockMatch[1]) {
                                const optimizedCode = codeBlockMatch[1].trim();
                                setCodeEditorContent(optimizedCode);

                                // Update the file content
                                if (activeAppFile) {
                                  const updatedFiles = generatedAppFiles.map(
                                    (file) =>
                                      file.id === activeAppFile.id
                                        ? { ...file, content: optimizedCode }
                                        : file
                                  );
                                  setGeneratedAppFiles(updatedFiles);
                                }

                                speakResponse(
                                  "I've optimized your code and updated the editor with the improved version."
                                );
                              } else {
                                speakResponse(
                                  "I've analyzed your code and suggested optimizations. Check the chat for details."
                                );
                              }
                            })
                            .catch((error) => {
                              console.error("Error optimizing code:", error);
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Optimize the code in ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content:
                                    "Sorry, I encountered an error while optimizing your code. Please try again.",
                                },
                              ]);
                            })
                            .finally(() => {
                              setIsAiHelperProcessing(false);
                            });
                        }}
                        disabled={isAiHelperProcessing || !activeAppFile}
                      >
                        <span className="icon">💡</span> Optimize Code
                      </button>
                    </li>
                    <li>
                      <button
                        className="helper-button"
                        onClick={() => {
                          setIsAiHelperProcessing(true);

                          if (!activeAppFile || !codeEditorContent) {
                            alert("Please select a file to add documentation");
                            setIsAiHelperProcessing(false);
                            return;
                          }

                          setAppCreatorChatHistory([
                            ...appCreatorChatHistory,
                            {
                              role: "user",
                              content: `Add documentation to ${activeAppFile.name}`,
                            },
                            {
                              role: "assistant",
                              content:
                                "Analyzing code and adding documentation...",
                            },
                          ]);

                          // Determine optimal model
                          const taskContext = {
                            taskType: "documentation",
                            fileType: activeAppFile.name.split(".").pop(),
                            prompt: "Add documentation",
                          };

                          const modelToUse =
                            selectOptimalModel(taskContext) || AI_MODELS.CLAUDE;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model: modelToUse,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert technical writer who specializes in code documentation. Add comprehensive JSDoc/TSDoc style comments to the provided code.
                                  Include:
                                  1. File-level documentation explaining the purpose and usage
                                  2. Complete JSDoc/TSDoc for all functions/methods/classes
                                  3. Parameter descriptions with types
                                  4. Return value documentation
                                  5. Examples where appropriate
                                  6. Inline comments for complex logic
                                  
                                  Return the fully documented code wrapped in a code block.`,
                                  },
                                  {
                                    role: "user",
                                    content: `Add professional documentation to this code from ${activeAppFile.name}:\n\n${codeEditorContent}\n\nProvide the documented version with JSDoc/TSDoc comments for classes, functions, and complex logic.`,
                                  },
                                ],
                                temperature: 0.1,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const documentationResult =
                                response.data.choices[0].message.content;

                              // Update chat history
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Add documentation to ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content: documentationResult,
                                },
                              ]);

                              // Extract code to update the editor
                              const codeBlockMatch = documentationResult.match(
                                /```(?:jsx?|tsx?|javascript|typescript)?\n([\s\S]*?)```/
                              );
                              if (codeBlockMatch && codeBlockMatch[1]) {
                                const documentedCode = codeBlockMatch[1].trim();
                                setCodeEditorContent(documentedCode);

                                // Update the file content
                                if (activeAppFile) {
                                  const updatedFiles = generatedAppFiles.map(
                                    (file) =>
                                      file.id === activeAppFile.id
                                        ? { ...file, content: documentedCode }
                                        : file
                                  );
                                  setGeneratedAppFiles(updatedFiles);
                                }

                                speakResponse(
                                  "I've added documentation to your code. The editor now shows the documented version."
                                );
                              } else {
                                speakResponse(
                                  "I've suggested documentation for your code. Check the chat for details."
                                );
                              }
                            })
                            .catch((error) => {
                              console.error(
                                "Error adding documentation:",
                                error
                              );
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Add documentation to ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content:
                                    "Sorry, I encountered an error while adding documentation. Please try again.",
                                },
                              ]);
                            })
                            .finally(() => {
                              setIsAiHelperProcessing(false);
                            });
                        }}
                        disabled={isAiHelperProcessing || !activeAppFile}
                      >
                        <span className="icon">📚</span> Add Documentation
                      </button>
                    </li>
                    <li>
                      <button
                        className="helper-button"
                        onClick={() => {
                          setIsAiHelperProcessing(true);

                          if (!activeAppFile || !codeEditorContent) {
                            alert("Please select a file to generate tests for");
                            setIsAiHelperProcessing(false);
                            return;
                          }

                          setAppCreatorChatHistory([
                            ...appCreatorChatHistory,
                            {
                              role: "user",
                              content: `Generate tests for ${activeAppFile.name}`,
                            },
                            {
                              role: "assistant",
                              content:
                                "Analyzing code and generating test cases...",
                            },
                          ]);

                          // Determine optimal model
                          const taskContext = {
                            taskType: "test-generation",
                            fileType: activeAppFile.name.split(".").pop(),
                            prompt: "Generate tests",
                          };

                          const modelToUse =
                            selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

                          axios
                            .post(
                              "https://api.groq.com/openai/v1/chat/completions",
                              {
                                model: modelToUse,
                                messages: [
                                  {
                                    role: "system",
                                    content: `You are an expert test writer. Create comprehensive test cases for the provided code using Jest and React Testing Library.
                                  Include:
                                  1. Unit tests for individual functions and components
                                  2. Integration tests for component interactions
                                  3. Tests for both happy paths and edge cases
                                  4. Proper mocking of dependencies and API calls
                                  5. Clear test descriptions and assertions
                                  
                                  Structure your test file with describe/it blocks and appropriate setup/teardown.
                                  Return the complete test file wrapped in a code block.`,
                                  },
                                  {
                                    role: "user",
                                    content: `Generate tests for this code from ${activeAppFile.name}:\n\n${codeEditorContent}\n\nCreate a complete test file with Jest/React Testing Library that covers the main functionality.`,
                                  },
                                ],
                                temperature: 0.2,
                                max_tokens: 4000,
                              },
                              {
                                headers: {
                                  Authorization: `Bearer ${GROQ_API_KEY}`,
                                  "Content-Type": "application/json",
                                },
                              }
                            )
                            .then((response) => {
                              const testsResult =
                                response.data.choices[0].message.content;

                              // Update chat history
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Generate tests for ${activeAppFile.name}`,
                                },
                                { role: "assistant", content: testsResult },
                              ]);

                              // Extract the test code
                              const codeBlockMatch = testsResult.match(
                                /```(?:jsx?|tsx?|javascript|typescript)?\n([\s\S]*?)```/
                              );
                              if (codeBlockMatch && codeBlockMatch[1]) {
                                // Create a new test file in the app
                                const testFileName = `${activeAppFile.name.replace(
                                  /\.(js|jsx|ts|tsx)$/,
                                  ""
                                )}.test.js`;
                                const testFileId = `src/__tests__/${testFileName}`;

                                // Check if test file already exists
                                const existingTestFileIndex =
                                  generatedAppFiles.findIndex(
                                    (file) => file.id === testFileId
                                  );

                                if (existingTestFileIndex >= 0) {
                                  // Update existing test file
                                  const updatedFiles = [...generatedAppFiles];
                                  updatedFiles[existingTestFileIndex] = {
                                    ...updatedFiles[existingTestFileIndex],
                                    content: codeBlockMatch[1].trim(),
                                  };
                                  setGeneratedAppFiles(updatedFiles);

                                  // Update app creator files
                                  setAppCreatorFiles([
                                    {
                                      id: "app-structure",
                                      name: "App Structure",
                                      type: "dir",
                                      content: "",
                                    },
                                    ...updatedFiles,
                                  ]);
                                } else {
                                  // Create new test file
                                  const newTestFile = {
                                    id: testFileId,
                                    name: testFileName,
                                    path: "src/__tests__/",
                                    type: "file",
                                    content: codeBlockMatch[1].trim(),
                                  };

                                  // Update files
                                  const updatedFiles = [
                                    ...generatedAppFiles,
                                    newTestFile,
                                  ];
                                  setGeneratedAppFiles(updatedFiles);

                                  // Update app creator files
                                  setAppCreatorFiles([
                                    {
                                      id: "app-structure",
                                      name: "App Structure",
                                      type: "dir",
                                      content: "",
                                    },
                                    ...updatedFiles,
                                  ]);
                                }

                                speakResponse(
                                  `I've generated tests for ${activeAppFile.name}. A new test file has been added to the project.`
                                );
                              } else {
                                speakResponse(
                                  "I've generated test recommendations. Check the chat for details."
                                );
                              }
                            })
                            .catch((error) => {
                              console.error("Error generating tests:", error);
                              setAppCreatorChatHistory([
                                ...appCreatorChatHistory.filter(
                                  (_, i) => i < appCreatorChatHistory.length - 1
                                ),
                                {
                                  role: "user",
                                  content: `Generate tests for ${activeAppFile.name}`,
                                },
                                {
                                  role: "assistant",
                                  content:
                                    "Sorry, I encountered an error while generating tests. Please try again.",
                                },
                              ]);
                            })
                            .finally(() => {
                              setIsAiHelperProcessing(false);
                            });
                        }}
                        disabled={isAiHelperProcessing || !activeAppFile}
                      >
                        <span className="icon">🧪</span> Generate Tests
                      </button>
                    </li>
                  </ul>
                </div>
              </div>

              <div className="app-creator-main">
                {appGenerationStep === "initial" ? (
                  <div className="app-description-form">
                    <h3>Describe Your {getProgrammingLanguageName()} App</h3>
                    <p>
                      Tell me what kind of {getProgrammingLanguageName()}{" "}
                      application you want to create:
                    </p>
                    <form onSubmit={handleAppDescriptionSubmit}>
                      <textarea
                        value={appDescription}
                        onChange={(e) => setAppDescription(e.target.value)}
                        placeholder={`E.g., I want to create a todo list app with user authentication, dark mode, and the ability to categorize tasks`}
                        rows={6}
                      ></textarea>

                      {/* Voice input section */}
                      <div className="voice-input-section">
                        <button
                          type="button"
                          className={`voice-input-button ${
                            isAppCreatorListening ? "listening" : ""
                          }`}
                          onClick={toggleAppCreatorListening}
                        >
                          <span className="icon">
                            {isAppCreatorListening ? "🎙️" : "🎤"}
                          </span>
                          {isAppCreatorListening
                            ? "Listening..."
                            : "Describe by voice"}
                        </button>
                        {appCreatorTranscript && (
                          <div className="voice-transcript">
                            <p>"{appCreatorTranscript}"</p>
                            <button
                              type="button"
                              onClick={() =>
                                setAppDescription(appCreatorTranscript)
                              }
                            >
                              Use this
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Image upload section */}
                      <div className="image-upload-section">
                        <h4>Add App Screenshots or Mockups (Optional)</h4>
                        <div className="image-upload-container">
                          <input
                            type="file"
                            id="app-image-upload"
                            accept="image/*"
                            onChange={(e) => handleImageUpload(e)}
                            className="image-input"
                          />
                          <label
                            htmlFor="app-image-upload"
                            className="image-upload-label"
                          >
                            <span className="icon">🖼️</span> Choose Image
                          </label>
                          {uploadedImage && (
                            <div className="image-preview">
                              <img src={uploadedImage} alt="App mockup" />
                              <button
                                type="button"
                                className="remove-image"
                                onClick={() => {
                                  setUploadedImage(null);
                                  setImageFile(null);
                                }}
                              >
                                ×
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <button type="submit" className="submit-button">
                        Continue
                      </button>
                    </form>
                  </div>
                ) : appGenerationStep === "requirements" ? (
                  <div className="app-requirements-form">
                    <h3>
                      Specify Requirements for {getProgrammingLanguageName()}
                    </h3>
                    <p>Provide more details about your requirements:</p>

                    {/* Add the image gallery here if we have any generated images */}
                    {(appGeneratedImages.length > 0 || uploadedImage) && (
                      <div className="app-image-gallery">
                        <h4>UI Design References</h4>
                        <div className="image-gallery-container">
                          {uploadedImage && (
                            <div
                              className={`gallery-image ${
                                selectedAppImage === "uploaded"
                                  ? "selected"
                                  : ""
                              }`}
                              onClick={() => setSelectedAppImage("uploaded")}
                            >
                              <img src={uploadedImage} alt="Uploaded mockup" />
                              <div className="image-label">Your mockup</div>
                            </div>
                          )}
                          {appGeneratedImages.map((image, index) => (
                            <div
                              key={index}
                              className={`gallery-image ${
                                selectedAppImage === index ? "selected" : ""
                              }`}
                              onClick={() => setSelectedAppImage(index)}
                            >
                              <img
                                src={image}
                                alt={`Generated UI mockup ${index + 1}`}
                              />
                              <div className="image-label">
                                {`Mockup ${index + 1}`}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="gallery-actions">
                          <button
                            className="regenerate-button"
                            onClick={() => {
                              // Generate new images using Pexels
                              setIsGeneratingImages(true);
                              const searchQuery = `${getProgrammingLanguageName()} ${appDescription} app UI`;

                              pexelsService
                                .searchImages(searchQuery, { perPage: 6 })
                                .then((results) => {
                                  setAppGeneratedImages(
                                    results.media.map((img) => img.src.large)
                                  );
                                  setAppCreatorChatHistory([
                                    ...appCreatorChatHistory,
                                    {
                                      role: "assistant",
                                      content:
                                        "I've found some new UI design references that match your app description.",
                                    },
                                  ]);
                                })
                                .catch((error) => {
                                  console.error(
                                    "Error generating new images:",
                                    error
                                  );
                                  setImageGenerationError(
                                    "Failed to generate new images. Please try again."
                                  );
                                })
                                .finally(() => {
                                  setIsGeneratingImages(false);
                                });
                            }}
                          >
                            <span className="icon">🔄</span> Generate New
                            Designs
                          </button>
                          {selectedAppImage !== null && (
                            <button
                              className="use-design-button"
                              onClick={() =>
                                setAppCreatorChatHistory([
                                  ...appCreatorChatHistory,
                                  {
                                    role: "user",
                                    content: `I want to use ${
                                      selectedAppImage === "uploaded"
                                        ? "my uploaded mockup"
                                        : `mockup ${selectedAppImage + 1}`
                                    } as the design reference.`,
                                  },
                                  {
                                    role: "assistant",
                                    content: `Great choice! I'll reference ${
                                      selectedAppImage === "uploaded"
                                        ? "your uploaded mockup"
                                        : `mockup ${selectedAppImage + 1}`
                                    } when generating the UI components.`,
                                  },
                                ])
                              }
                            >
                              <span className="icon">✓</span> Use This Design
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Add the video gallery if we have videos */}
                    {pexelsVideos.length > 0 && (
                      <div className="app-video-gallery">
                        <h4>Video Content References</h4>
                        <div className="video-gallery-container">
                          {pexelsVideos.map((video, index) => (
                            <div key={index} className="gallery-video">
                              <div className="video-preview">
                                <img
                                  src={video.image}
                                  alt={`Video preview ${index + 1}`}
                                />
                                <div className="video-play-overlay">▶</div>
                              </div>
                              <div className="video-info">
                                <div className="video-label">
                                  Video {index + 1}
                                </div>
                                <div className="video-duration">
                                  {video.duration}s
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="gallery-actions">
                          <button
                            className="regenerate-button"
                            onClick={() => {
                              setIsPexelsLoading(true);
                              const searchQuery = `${getProgrammingLanguageName()} ${appDescription}`;

                              pexelsService
                                .searchVideos(searchQuery, { perPage: 3 })
                                .then((results) => {
                                  setPexelsVideos(results.media);
                                })
                                .catch((error) => {
                                  console.error(
                                    "Error searching videos:",
                                    error
                                  );
                                })
                                .finally(() => {
                                  setIsPexelsLoading(false);
                                });
                            }}
                          >
                            <span className="icon">🔄</span> Find More Videos
                          </button>
                        </div>
                      </div>
                    )}

                    {isGeneratingImages && (
                      <div className="generating-images-indicator">
                        <div className="loading-spinner"></div>
                        <p>
                          Generating UI mockups based on your description...
                        </p>
                      </div>
                    )}

                    {imageGenerationError && (
                      <div className="error-message">
                        <p>Error generating images: {imageGenerationError}</p>
                        <p>You can still proceed with app generation.</p>
                      </div>
                    )}

                    <form onSubmit={handleAppRequirementsSubmit}>
                      <textarea
                        value={appRequirements}
                        onChange={(e) => setAppRequirements(e.target.value)}
                        placeholder={`E.g., Must use React Router, Redux for state management, and have responsive design. Target audience is students.`}
                        rows={6}
                      ></textarea>

                      {/* Voice input for requirements */}
                      <div className="voice-input-section">
                        <button
                          type="button"
                          className={`voice-input-button ${
                            isAppCreatorListening ? "listening" : ""
                          }`}
                          onClick={toggleAppCreatorListening}
                        >
                          <span className="icon">
                            {isAppCreatorListening ? "🎙️" : "🎤"}
                          </span>
                          {isAppCreatorListening
                            ? "Listening..."
                            : "Describe by voice"}
                        </button>
                        {appCreatorTranscript && (
                          <div className="voice-transcript">
                            <p>"{appCreatorTranscript}"</p>
                            <button
                              type="button"
                              onClick={() =>
                                setAppRequirements(appCreatorTranscript)
                              }
                            >
                              Use this
                            </button>
                          </div>
                        )}
                      </div>

                      {uploadedImage && (
                        <div className="image-reference">
                          <h4>Using uploaded mockup as reference:</h4>
                          <div className="small-image-preview">
                            <img
                              src={uploadedImage}
                              alt="App mockup reference"
                            />
                          </div>
                        </div>
                      )}

                      <div className="form-actions">
                        <button
                          type="button"
                          className="generate-images-button"
                          onClick={() => {
                            setIsGeneratingImages(true);
                            const searchQuery = `${getProgrammingLanguageName()} ${appDescription} app UI`;

                            pexelsService
                              .searchImages(searchQuery, { perPage: 6 })
                              .then((results) => {
                                setAppGeneratedImages(
                                  results.media.map((img) => img.src.large)
                                );
                                setAppCreatorChatHistory([
                                  ...appCreatorChatHistory,
                                  {
                                    role: "assistant",
                                    content:
                                      "I've found some UI design references that match your app description.",
                                  },
                                ]);
                              })
                              .catch((error) => {
                                console.error(
                                  "Error generating images:",
                                  error
                                );
                                setImageGenerationError(
                                  "Failed to generate images. Please try again."
                                );
                              })
                              .finally(() => {
                                setIsGeneratingImages(false);
                              });
                          }}
                          disabled={isGeneratingImages}
                        >
                          {isGeneratingImages
                            ? "Generating..."
                            : "Generate UI Mockups"}
                        </button>
                        <button
                          type="submit"
                          className="submit-button"
                          disabled={isCreatingApp}
                        >
                          {isCreatingApp
                            ? "Generating App..."
                            : `Generate ${getProgrammingLanguageName()} App`}
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="code-editor-container">
                    {activeAppFile ? (
                      <>
                        <div className="editor-header">
                          <h3>
                            {activeAppFile.path}
                            {activeAppFile.name}
                          </h3>
                        </div>
                        <textarea
                          className="code-editor"
                          value={codeEditorContent}
                          onChange={(e) => {
                            setCodeEditorContent(e.target.value);
                            // Update the file content in generatedAppFiles
                            if (activeAppFile) {
                              const updatedFiles = generatedAppFiles.map(
                                (file) =>
                                  file.id === activeAppFile.id
                                    ? { ...file, content: e.target.value }
                                    : file
                              );
                              setGeneratedAppFiles(updatedFiles);
                            }
                          }}
                          spellCheck="false"
                        ></textarea>
                      </>
                    ) : (
                      <div className="no-file-selected">
                        <p>Select a file to view and edit</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="app-creator-chat">
                <div className="chat-header">
                  <h3> GitHub Copilot Assistant</h3>
                </div>
                <div className="chat-messages">
                  {appCreatorChatHistory.map((message, index) => (
                    <div key={index} className={`chat-message ${message.role}`}>
                      <div
                        className="message-content"
                        dangerouslySetInnerHTML={{
                          __html: formatMarkdown(message.content),
                        }}
                      ></div>
                    </div>
                  ))}
                  {isCreatingApp && (
                    <div className="chat-message assistant loading">
                      <div className="loading-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                      <p>
                        Generating your {getProgrammingLanguageName()}{" "}
                        application...
                      </p>
                    </div>
                  )}
                  {isAiHelperProcessing && (
                    <div className="chat-message assistant loading">
                      <div className="loading-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                      <p>Processing your request...</p>
                    </div>
                  )}
                  {appGenerationError && (
                    <div className="chat-message error">
                      <div className="message-content">
                        <h4>Error creating app:</h4>
                        <p>{appGenerationError}</p>
                        <p>
                          Please try again with different requirements or
                          contact support if this persists.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                <form
                  className="chat-input-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (appCreatorChatInput.trim()) {
                      // Add user message to chat history
                      setAppCreatorChatHistory([
                        ...appCreatorChatHistory,
                        { role: "user", content: appCreatorChatInput },
                      ]);

                      // Process with the right AI model
                      setIsAiHelperProcessing(true);
                      const taskContext = {
                        taskType: "app-creation-chat",
                        prompt: appCreatorChatInput,
                      };

                      const modelToUse =
                        selectOptimalModel(taskContext) || AI_MODELS.LLAMA;

                      axios
                        .post(
                          "https://api.groq.com/openai/v1/chat/completions",
                          {
                            model: modelToUse,
                            messages: [
                              {
                                role: "system",
                                content: `You are an expert ${getProgrammingLanguageName()} developer assistant. Help the user with their app development questions.
                                        
                              When answering questions:
                              1. Provide specific, actionable advice relevant to ${getProgrammingLanguageName()}
                              2. Include code examples when helpful
                              3. Explain concepts clearly and thoroughly
                              4. Consider best practices and common pitfalls
                              5. Focus on production-quality recommendations`,
                              },
                              ...appCreatorChatHistory.slice(-6).map((msg) => ({
                                role: msg.role,
                                content: msg.content,
                              })),
                              {
                                role: "user",
                                content: appCreatorChatInput,
                              },
                            ],
                            temperature: 0.2,
                            max_tokens: 4000,
                          },
                          {
                            headers: {
                              Authorization: `Bearer ${GROQ_API_KEY}`,
                              "Content-Type": "application/json",
                            },
                          }
                        )
                        .then((response) => {
                          const assistantResponse =
                            response.data.choices[0].message.content;

                          setAppCreatorChatHistory((prev) => [
                            ...prev,
                            { role: "assistant", content: assistantResponse },
                          ]);
                        })
                        .catch((error) => {
                          console.error("Error in app creator chat:", error);
                          setAppCreatorChatHistory((prev) => [
                            ...prev,
                            {
                              role: "assistant",
                              content:
                                "I'm sorry, I encountered an error processing your request. Please try again.",
                            },
                          ]);
                        })
                        .finally(() => {
                          setIsAiHelperProcessing(false);
                        });

                      // Clear input after sending
                      setAppCreatorChatInput("");
                    }
                  }}
                >
                  <input
                    type="text"
                    placeholder="Ask something about your app..."
                    value={appCreatorChatInput}
                    onChange={(e) => setAppCreatorChatInput(e.target.value)}
                    disabled={
                      appGenerationStep !== "complete" || isAiHelperProcessing
                    }
                    className="chat-input"
                  />
                  <button
                    type="submit"
                    disabled={
                      appGenerationStep !== "complete" || isAiHelperProcessing
                    }
                  >
                    <span className="icon">📨</span>
                  </button>
                </form>
              </div>
            </div>

            {/* Preview Modal */}
            {showPreview && (
              <div className="preview-modal">
                <div className="preview-content">
                  <div className="preview-header">
                    <h3>App Preview</h3>
                    <div className="preview-device-selector">
                      <button
                        className={`device-button ${
                          previewDevice === "mobile" ? "active" : ""
                        }`}
                        onClick={() => setPreviewDevice("mobile")}
                        title="Mobile View"
                      >
                        📱
                      </button>
                      <button
                        className={`device-button ${
                          previewDevice === "tablet" ? "active" : ""
                        }`}
                        onClick={() => setPreviewDevice("tablet")}
                        title="Tablet View"
                      >
                        📱+
                      </button>
                      <button
                        className={`device-button ${
                          previewDevice === "desktop" ? "active" : ""
                        }`}
                        onClick={() => setPreviewDevice("desktop")}
                        title="Desktop View"
                      >
                        💻
                      </button>
                    </div>
                    <button
                      className="close-preview-btn"
                      onClick={() => setShowPreview(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className={`preview-container ${previewDevice}`}>
                    {previewError ? (
                      <div className="preview-error">
                        <p>{previewError}</p>
                      </div>
                    ) : (
                      <iframe
                        ref={previewIframeRef}
                        className="preview-iframe"
                        srcDoc={previewHtml}
                        title="App Preview"
                        sandbox="allow-scripts allow-same-origin"
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          // Home Page
          <>
            <h1>ORCA</h1>
            <div className="search-container">
              <input
                type="text"
                placeholder="Search GitHub Projects..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    fetchProjects();
                  }
                }}
                className="search-input"
              />
              <button
                className="search-button"
                onClick={() => {
                  setIsGroqSearching(true);
                  setGroqSearchResults([]);

                  if (!searchTerm.trim()) {
                    setIsGroqSearching(false);
                    return;
                  }

                  // Use AI to find the best projects
                  axios
                    .post(
                      "https://api.groq.com/openai/v1/chat/completions",
                      {
                        model: AI_MODELS.LLAMA,
                        messages: [
                          {
                            role: "system",
                            content: `You are a helpful GitHub project recommendation assistant. When users ask for project recommendations, provide 4-6 specific GitHub projects as JSON.
                          
                          Format your response as JSON with this structure:
                          {
                            "projects": [
                              {
                                "name": "Project Name",
                                "repoUrl": "https://github.com/owner/repo",
                                "description": "Brief project description",
                                "tags": ["Tag1", "Tag2"],
                                "difficulty": "Beginner|Intermediate|Advanced",
                                "stars": "approximate star count",
                                "language": "Primary programming language"
                              }
                            ]
                          }`,
                          },
                          {
                            role: "user",
                            content: `Find the best GitHub repositories related to: ${searchTerm}`,
                          },
                        ],
                        temperature: 0.3,
                        max_tokens: 1000,
                        response_format: { type: "json_object" },
                      },
                      {
                        headers: {
                          Authorization: `Bearer ${GROQ_API_KEY}`,
                          "Content-Type": "application/json",
                        },
                      }
                    )
                    .then((response) => {
                      try {
                        const searchResults = JSON.parse(
                          response.data.choices[0].message.content
                        );
                        setGroqSearchResults(searchResults.projects || []);
                        speakResponse(
                          `I found ${searchResults.projects.length} repositories related to ${searchTerm}`
                        );
                      } catch (error) {
                        console.error("Error parsing search results:", error);
                        setGroqSearchResults([]);
                      }
                    })
                    .catch((error) => {
                      console.error("Error searching projects with AI:", error);
                    })
                    .finally(() => {
                      setIsGroqSearching(false);
                    });
                }}
                title="Search with AI"
                disabled={isGroqSearching}
              >
                {isGroqSearching ? "🔄" : "🔍"}
              </button>
              <button
                className={`voice-button ${isListening ? "listening" : ""}`}
                onClick={toggleListening}
                title="Search by voice"
              >
                {isListening ? "🎙️" : "🎤"}
              </button>
              <button
                className="settings-button"
                onClick={() => setShowVoiceSettings(true)}
                title="Voice settings"
              >
                ⚙️
              </button>
              <button
                className="choose-button"
                onClick={() => setIsNewUserModalOpen(true)}
                title="I'm new here"
              >
                <span className="icon">✨</span> I'm New
              </button>
              <button
                className="create-app-button"
                onClick={() => {
                  setIsAppCreatorOpen(true);
                  setAppCreatorFiles([
                    {
                      id: "app-structure",
                      name: "App Structure",
                      type: "dir",
                      content: "",
                    },
                    {
                      id: "app-requirements",
                      name: "Requirements",
                      type: "file",
                      content: "",
                    },
                  ]);
                  setActiveAppFile({
                    id: "app-requirements",
                    name: "Requirements",
                    type: "file",
                    content: "",
                  });
                  setCodeEditorContent("");
                  setAppGenerationStep("initial");
                  setAppDescription("");
                  setAppRequirements("");
                  setGeneratedAppFiles([]);
                  setUploadedImage(null);
                  setImageFile(null);
                  setAppCreatorChatHistory([]);
                  setAppGeneratedImages([]);
                  setSelectedAppImage(null);
                  setAppUiComponents([]);
                  setImageGenerationError(null);
                  setAppGenerationError(null);
                }}
                title="Create a new app"
              >
                <span className="icon">🚀</span> Create App
              </button>
            </div>

            {/* Follow-up question display */}
            {needsFollowUp && waitingForFollowUp && (
              <div className="followup-question">
                <p>{followUpQuestion}</p>
                <button onClick={toggleListening} className="answer-button">
                  {isListening ? "Listening..." : "Answer by voice"}
                </button>
              </div>
            )}

            {/* Voice response display */}
            {chatResponse && (
              <div className="voice-response">
                <h3>Assistant Response</h3>
                <div
                  className="response-content"
                  dangerouslySetInnerHTML={{
                    __html: formatMarkdown(chatResponse),
                  }}
                ></div>
                <button
                  onClick={() => speakResponse(chatResponse)}
                  className="speak-again"
                >
                  🔊 Speak Again
                </button>
              </div>
            )}

            {loading && <div className="loading">Loading projects...</div>}
            {isGroqSearching && (
              <div className="loading">
                Searching for the best {searchTerm} projects with AI...
              </div>
            )}
            {error && <div className="error">{error}</div>}

            <div className="project-cards">
              {githubProjects.map((project) => (
                <div
                  key={project.id}
                  className="project-card"
                  onClick={() => handleProjectClick(project)}
                >
                  <h2>{project.name}</h2>
                  <p className="owner">by {project.owner.login}</p>
                  <p className="description">
                    {project.description
                      ? project.description.length > 100
                        ? `${project.description.substring(0, 100)}...`
                        : project.description
                      : "No description available."}
                  </p>
                  <div className="project-stats">
                    <span>⭐ {project.stargazers_count}</span>
                    <span>🍴 {project.forks_count}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Groq Search Results */}
            {groqSearchResults.length > 0 && (
              <div className="groq-search-results">
                <h2>🤖 AI-Recommended Projects</h2>
                <div className="groq-project-cards">
                  {groqSearchResults.map((project, index) => (
                    <div key={index} className="groq-project-card">
                      <h3>{project.name}</h3>
                      <p className="description">{project.description}</p>
                      <div className="project-meta">
                        <span className="language">{project.language}</span>
                        <span className="stars">⭐ {project.stars}</span>
                        <span
                          className={`difficulty ${project.difficulty.toLowerCase()}`}
                        >
                          {project.difficulty}
                        </span>
                      </div>
                      <div className="tags">
                        {project.tags &&
                          project.tags.map((tag, idx) => (
                            <span key={idx} className="tag">
                              {tag}
                            </span>
                          ))}
                      </div>
                      <div className="card-actions">
                        <button
                          className="view-repo-btn"
                          onClick={() => {
                            const urlParts = project.repoUrl
                              .replace("https://github.com/", "")
                              .split("/");
                            const owner = urlParts[0];
                            const repo = urlParts[1];

                            // Load the repository and navigate
                            handleProjectClick({
                              name: repo,
                              owner: { login: owner },
                            });
                          }}
                        >
                          <span className="icon">🔍</span> Explore Repository
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Router>
  );
};

export default App;
