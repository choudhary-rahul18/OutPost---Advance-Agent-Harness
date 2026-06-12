// ── CampaignContext — the data bus between tasks ─────────────────────────────
// Each task can declare an outputKey; its result (the done() summary) is
// stored here. Later tasks reference it with {{key}} placeholders in their
// system prompts — the orchestrator renders them before the task runs.
// Think of it as a Python dict passed down a pipeline.
export class CampaignContext {
  private store = new Map<string, string>();

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  // Replace every {{key}} in the template with the stored value.
  // Unknown keys are left as-is so the failure is visible, not silent.
  render(template: string): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => this.store.get(key) ?? match);
  }
}
