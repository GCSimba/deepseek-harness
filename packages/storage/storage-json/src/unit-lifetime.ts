/** Shared JSON-unit retirement and quiescent release for both storage layouts. */
import { StorageError } from '@deepseek-ai/dsh-storage'
import { PublishedWriteDurabilityError } from './atomic.ts'

/** Internal lifecycle controller: post-publication failures retire the unit before rejecting. */
export class JsonUnitLifetime {
  private readonly inFlight = new Set<Promise<unknown>>()
  private disposal?: Promise<void>

  /**
   * @param name - Unit name for closed diagnostics.
   * @param onClose - Backend callback releasing the unit's reserved name.
   */
  constructor(private readonly name: string, private readonly onClose: () => void) {}

  /** Reject use after ordinary close or uncertain publication. */
  assertOpen(): void {
    if (this.disposal !== undefined) throw new StorageError('closed', `unit '${this.name}' is closed`)
  }

  /**
   * Track a medium operation and retire after uncertain publication.
   * @param operation - Admitted operation, including any file publication during reads.
   * @returns the result, or a rejection after terminal teardown has settled.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const pending = operation()
    this.inFlight.add(pending)
    try {
      return await pending
    } catch (error) {
      if (error instanceof PublishedWriteDurabilityError) {
        this.inFlight.delete(pending)
        await this.close()
        throw new StorageError('closed', `unit '${this.name}' is closed after an uncertain publication`, { cause: error })
      }
      throw error
    } finally {
      this.inFlight.delete(pending)
    }
  }

  /**
   * Block new operations, drain admitted I/O and release the name once.
   * @returns the shared teardown promise.
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }
}
