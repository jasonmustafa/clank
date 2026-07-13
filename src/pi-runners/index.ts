export type TextHandler = (text: string) => void | Promise<void>;

export interface FakeRunnerOptions {
  chunks?: readonly string[];
  final?: string;
}

/** Deterministic development runner used before the Pi SDK runner is available. */
export class FakeRunner {
  readonly #chunks: readonly string[];
  readonly #final: string;

  constructor(options: FakeRunnerOptions = {}) {
    this.#chunks = options.chunks ?? ["Clank is working..."];
    this.#final = options.final ?? "Fake runner completed the job.";
  }

  async run(_prompt: string, onText: TextHandler = () => undefined): Promise<string> {
    for (const chunk of this.#chunks) await onText(chunk);
    return this.#final;
  }
}
