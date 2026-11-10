import type { AskAnswer, AskGate, AskRequest } from '../tools/types.ts'

export type AskPrompt = (request: AskRequest & { id: string }) => Promise<AskAnswer>

class StaticAsk implements AskGate {
  private readonly answer: AskAnswer

  constructor(answer: AskAnswer) {
    this.answer = answer
  }

  async request(): Promise<AskAnswer> {
    return this.answer
  }
}

class PromptAsk implements AskGate {
  private readonly prompt: AskPrompt

  constructor(prompt: AskPrompt) {
    this.prompt = prompt
  }

  async request(request: AskRequest & { id: string }): Promise<AskAnswer> {
    return this.prompt(request)
  }
}

/** Non-interactive contexts: every question is skipped and the model continues. */
export function skipAsks(): AskGate {
  return new StaticAsk({ status: 'skipped' })
}

/** Resolve each question with a human (terminal prompt, web UI, …). */
export function promptAsk(prompt: AskPrompt): AskGate {
  return new PromptAsk(prompt)
}
