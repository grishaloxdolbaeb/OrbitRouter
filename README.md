# Orbit Router – A Programmable Gateway for AI Workflows
Orbit is a free, cloud-routed networking tool built for one thing: seamless programmatic access to AI services via your Kiro AI and ChatGPT accounts.

It is not a consumer mesh router. It does not care about your Netflix stream or your ping in Valorant.

Orbit is a thin routing layer that sits between your code and the AI endpoints you rely on. Instead of managing API keys and connection logic manually inside every script, Orbit centralizes routing, authentication, and session handling for your AI agents.

How It Works
You connect your Kiro AI and OpenAI (ChatGPT) accounts to Orbit.

The router exposes a unified, lightweight interface (REST / WebSocket) for your local development environment.

Orbit handles the underlying routing — not locally, but via a lightweight cloud coordination layer. This keeps your dev machine clean and your credentials out of your source code.

What Orbit Actually Does
Account Aggregation – Use multiple AI accounts (Kiro, ChatGPT, or custom OpenAI-compatible endpoints) from a single access point.

Credential Isolation – API keys live inside Orbit’s secure session storage, not in your .env files.

Stateless Routing – Each request is tagged with your preferred AI provider and routed accordingly.

No Vendor Lock-in – Switch between Kiro and ChatGPT without rewriting your code. Just change a header or a query param.

Who Is It For
Developers experimenting with AI agents

Hackathon participants who need quick multi-provider access

Anyone tired of copying API keys between projects

Important Note
Orbit is not a local omniroute. It uses a cloud-assisted routing backend to keep the router lightweight and account-agnostic. Your data is not logged or stored — only transiently forwarded.

Orbit Router – code once, route to any AI.
