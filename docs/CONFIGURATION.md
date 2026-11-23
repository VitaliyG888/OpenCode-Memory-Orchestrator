# Configuration

The installer uses the safe templates:

- `.opencode/memory.config.example.json`
- `.opencode/orchestrator.config.example.json`

It merges defaults into the target project's runtime files:

- `.opencode/memory.config.json`
- `.opencode/orchestrator.config.json`

Keep runtime files local and never commit API keys. The example model IDs are defaults from the uploaded source archive; select provider/model combinations that support the relevant API endpoints. Embedding models must support `/embeddings`; chat models must support chat completions.


The published example currently defaults to `nvidia/nemotron-3-ultra-550b-a55b:free` for chat-based Intelligence and `nvidia/nemotron-3-embed-1b:free` for embeddings. These are separate model roles; verify current provider availability and endpoint support before deployment.
