import { SwapEventData } from "../types";

export class QueueService {
  private isGloballyProcessing: boolean = false;
  private eventQueue: SwapEventData[] = [];
  private processQueue: boolean = true;
  private maxQueueSize: number = 100;
  private lastProcessedTime: number = 0;
  private processingCooldown: number = 1000;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  private errorBackoffTime: number = 30000;
  private lastErrorTime: number = 0;

  constructor(private onProcessCallback: () => Promise<void>) {
    this.startQueueProcessor();
  }

  public addToQueue(eventData: SwapEventData): void {
    if (this.eventQueue.length >= this.maxQueueSize) {
      console.log(
        `⚠️ Event queue full (${this.maxQueueSize}), dropping oldest events`
      );
      this.eventQueue.shift();
    }
    this.eventQueue.push(eventData);
  }

  public getQueueSize(): number {
    return this.eventQueue.length;
  }

  public trackError(): void {
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();
  }

  public resetErrors(): void {
    this.consecutiveErrors = 0;
  }

  private startQueueProcessor(): void {
    setInterval(() => {
      if (
        this.eventQueue.length > 0 &&
        !this.isGloballyProcessing &&
        this.processQueue
      ) {
        this.processEventQueue().catch((error) => {
          console.error(`❌ Queue processor error: ${error.message}`);
        });
      }
    }, 3000); // Check every 3 seconds
  }

  private async processEventQueue(): Promise<void> {
    if (this.isGloballyProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isGloballyProcessing = true;
    const now = Date.now();

    try {
      const eventData = this.eventQueue.pop();
      if (!eventData) {
        return;
      }

      // Clear the queue as we're processing
      this.eventQueue = [];

      const timestamp = new Date().toLocaleString();
      console.log(`\n🔔 PROCESSING SWAP EVENT`);
      console.log(`⏰ ${timestamp}`);
      console.log(`🌐 Network: ${eventData.network}`);
      console.log(`🏊 Pool: ${eventData.poolAddress}`);
      console.log(`📋 Tx: ${eventData.txHash}`);
      console.log(`#️⃣ Block: ${eventData.blockNumber}`);
      console.log(`👤 Sender: ${eventData.sender}`);
      console.log("=".repeat(60));

      this.lastProcessedTime = now;

      // Execute callback for processing
      await this.onProcessCallback();
    } catch (error: any) {
      console.error(`❌ Error processing event queue: ${error.message}`);
      this.consecutiveErrors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isGloballyProcessing = false;
    }
  }

  public shouldSkipProcessing(): boolean {
    const now = Date.now();

    // Skip if already processing (sequential execution)
    if (this.isGloballyProcessing) {
      console.log(`⏸️ Already processing, skipping...`);
      return true;
    }

    // Skip if too many consecutive errors and in backoff period
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      if (now - this.lastErrorTime < this.errorBackoffTime) {
        console.log(
          `⏸️ In error backoff period (${this.consecutiveErrors} consecutive errors)`
        );
        return true;
      } else {
        // Reset error count after backoff period
        this.consecutiveErrors = 0;
      }
    }

    // Basic cooldown
    if (now - this.lastProcessedTime < this.processingCooldown) {
      return true;
    }

    return false;
  }

  // Configuration methods
  public setProcessingCooldown(milliseconds: number): void {
    this.processingCooldown = milliseconds;
  }

  // public getStatus(): object {
  //   return {
  //     isGloballyProcessing: this.isGloballyProcessing,
  //     lastProcessedTime: this.lastProcessedTime,
  //     processingCooldown: this.processingCooldown,
  //     eventQueueSize: this.eventQueue.length,
  //     consecutiveErrors: this.consecutiveErrors,
  //   };
  // }

  public stopProcessing(): void {
    console.log("🛑 Stopping queue processor...");
    this.processQueue = false;
    this.eventQueue = [];
    this.isGloballyProcessing = false;
  }

  // Add a method to check if processing is stopped
  public isProcessingStopped(): boolean {
    return !this.processQueue;
  }
}
