"use client";

import { useState, useRef, useEffect } from "react";
import {
  MessageSquare,
  Send,
  Bot,
  User,
  Sparkles,
  AlertCircle,
  RotateCcw,
  Copy,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { mockChatHistory, ChatMessage } from "@/lib/mock-data";

const suggestedQuestions = [
  "Why did my deployment fail?",
  "How do I fix the Trivy security scan?",
  "Configure health check endpoint",
  "How to set up environment variables?",
  "Explain Terraform state locking",
  "Rollback to previous deployment",
];

export default function ChatbotPage() {
  const [messages, setMessages] = useState<ChatMessage[]>(mockChatHistory);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = (text?: string) => {
    const messageText = text || input;
    if (!messageText.trim()) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: messageText,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    // Simulate AI response
    setTimeout(() => {
      const aiMsg: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        role: "assistant",
        content: generateResponse(messageText),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMsg]);
      setIsTyping(false);
    }, 1500 + Math.random() * 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      {/* Header */}
      <div className="p-5 border-b border-border bg-deployguard-900/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-accent-blue flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold">AI Troubleshooting Assistant</h1>
              <p className="text-xs text-deployguard-400">
                Powered by LLM • Analyzes deployment logs & provides remediation
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-accent-cyan">
              <span className="w-2 h-2 rounded-full bg-accent-cyan" />
              Online
            </span>
            <button
              onClick={() => setMessages([])}
              className="flex items-center gap-1.5 text-xs text-deployguard-400 hover:text-white bg-deployguard-800 px-3 py-1.5 rounded-lg transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-purple to-accent-blue flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-xl font-bold mb-2">DeployGuard AI Assistant</h2>
            <p className="text-sm text-deployguard-400 max-w-md mb-8">
              I can help you troubleshoot deployment failures, analyze logs, explain Terraform errors,
              and provide remediation steps. Ask me anything about your infrastructure.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="text-left text-sm bg-deployguard-800 border border-border rounded-lg px-4 py-3 text-deployguard-300 hover:text-white hover:border-border-light transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex items-start gap-3 animate-slide-up ${
              msg.role === "user" ? "justify-end" : ""
            }`}
          >
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-purple to-accent-blue flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-white" />
              </div>
            )}
            <div
              className={`max-w-2xl rounded-xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-accent-cyan/15 border border-accent-cyan/20"
                  : "bg-deployguard-900 border border-border"
              }`}
            >
              <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                {msg.role === "assistant" ? (
                  <div className="whitespace-pre-wrap">
                    {msg.content.split("```").map((part, i) =>
                      i % 2 === 1 ? (
                        <pre key={i} className="bg-deployguard-950 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono border border-border">
                          <code>{part}</code>
                        </pre>
                      ) : (
                        <span key={i}>{renderMarkdownish(part)}</span>
                      )
                    )}
                  </div>
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
              {msg.role === "assistant" && (
                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/50">
                  <button className="text-deployguard-500 hover:text-accent-cyan transition-colors p-1">
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button className="text-deployguard-500 hover:text-accent-cyan transition-colors p-1">
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button className="text-deployguard-500 hover:text-accent-red transition-colors p-1">
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[10px] text-deployguard-600 ml-auto">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="w-8 h-8 rounded-lg bg-accent-cyan/20 flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-accent-cyan" />
              </div>
            )}
          </div>
        ))}

        {isTyping && (
          <div className="flex items-start gap-3 animate-slide-up">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-purple to-accent-blue flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="bg-deployguard-900 border border-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse-dot" />
                <div className="w-2 h-2 rounded-full bg-accent-blue animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
                <div className="w-2 h-2 rounded-full bg-accent-purple animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Questions */}
      {messages.length > 0 && (
        <div className="px-6 py-2 border-t border-border/50 flex items-center gap-2 overflow-x-auto flex-shrink-0">
          <span className="text-[10px] text-deployguard-500 uppercase tracking-wider flex-shrink-0">Suggest:</span>
          {suggestedQuestions.slice(0, 4).map((q) => (
            <button
              key={q}
              onClick={() => handleSend(q)}
              className="text-xs bg-deployguard-800 border border-border rounded-full px-3 py-1.5 text-deployguard-400 hover:text-white hover:border-border-light transition-colors whitespace-nowrap flex-shrink-0"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-border bg-deployguard-900/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-end gap-3">
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about deployment errors, Terraform issues, or infrastructure..."
              rows={1}
              className="w-full bg-deployguard-800 border border-border rounded-xl px-4 py-3 text-sm placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors resize-none"
            />
          </div>
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isTyping}
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-deployguard-600 mt-2 text-center">
          AI responses are based on deployment log analysis. Verify suggestions against your infrastructure before applying.
        </p>
      </div>
    </div>
  );
}

function renderMarkdownish(text: string) {
  // Simple markdown-like rendering
  return text.split("\n").map((line, i) => {
    if (line.startsWith("## ")) {
      return <h2 key={i} className="text-base font-bold mt-3 mb-1">{line.slice(3)}</h2>;
    }
    if (line.startsWith("### ")) {
      return <h3 key={i} className="text-sm font-bold mt-2 mb-1">{line.slice(4)}</h3>;
    }
    if (line.startsWith("- ")) {
      return <li key={i} className="ml-4 text-deployguard-300">{line.slice(2)}</li>;
    }
    if (line.match(/^\d+\./)) {
      return <li key={i} className="ml-4 text-deployguard-300 list-decimal">{line.replace(/^\d+\.\s*/, "")}</li>;
    }
    if (line.trim() === "") {
      return <br key={i} />;
    }
    return <span key={i}>{line}<br /></span>;
  });
}

function generateResponse(question: string): string {
  if (question.toLowerCase().includes("fail")) {
    return `## Deployment Failure Analysis

**Root Cause:** The deployment pipeline was blocked at the Security Scanning stage.

### Key Findings:
1. **Aqua Trivy Scan** detected 2 critical vulnerabilities
2. Zero-trust policy automatically blocked the deployment
3. Vulnerable packages: lodash@4.17.20, node-fetch@2.6.0

### Remediation Steps:
1. Run \`npm update lodash@4.17.21\`
2. Run \`npm update node-fetch@2.7.0\`
3. Commit the updated \`package-lock.json\`
4. Re-trigger the deployment pipeline

The deployment will automatically proceed through all stages once vulnerabilities are resolved.`;
  }
  if (question.toLowerCase().includes("trivy") || question.toLowerCase().includes("security")) {
    return `## Trivy Security Scan Guide

Aqua Trivy is integrated as a mandatory pre-deployment security gate in DeployGuard.

### How It Works:
1. After Docker image is built, Trivy scans OS packages and application dependencies
2. Findings are compared against public CVE databases
3. Policy engine evaluates severity levels against security rules

### Policy Rules:
- **CRITICAL/HIGH** → Deployment automatically blocked
- **MEDIUM (threshold > 3)** → Manual approval required
- **LOW** → Logged but doesn't block

### To Fix Vulnerabilities:
\`\`\`
npm audit fix
npm update <package>@<fixed-version>
\`\`\`

All scan results are immutably logged in the audit trail.`;
  }
  if (question.toLowerCase().includes("health")) {
    return `## Health Check Configuration

DeployGuard configures ALB health checks on your \`/health\` endpoint for ECS Fargate deployments.

### Required Setup:
\`\`\`javascript
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
\`\`\`

### Default Settings:
- **Path:** /health
- **Interval:** 30 seconds
- **Healthy threshold:** 3 successes
- **Unhealthy threshold:** 3 failures

### Important:
If health check fails 3 consecutive times, DeployGuard triggers an automatic zero-downtime rollback to the previous stable Git commit.`;
  }
  return `## DeployGuard Assistant

I can help you with:

1. **Deployment troubleshooting** — Analyze failed deployment logs and provide remediation steps
2. **Security scans** — Explain Trivy findings and how to fix vulnerabilities
3. **Infrastructure** — Guide on Terraform state, VPC configuration, and ECS setup
4. **Cost optimization** — Explain Infracost estimates and Fargate Spot savings
5. **Health checks** — Configure and troubleshoot ALB health endpoints

Please ask a specific question about your deployment or infrastructure, and I'll provide detailed guidance.`;
}
