import type { Client, McpSubscription } from "@modelcontextprotocol/client";
import { failure } from "./diagnostics.js";

interface Watch {
  changed: boolean;
  stream?: McpSubscription;
}

/** One connection's explicit watches. Notifications never fetch or attach bodies. */
export class ResourceSubscriptions {
  private watches = new Map<string, Watch>();
  private queue: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();

  constructor(private client: Client, private server: string, private timeout: number,
    private notify: (uri: string) => void) {
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      if (this.lifetime.signal.aborted) return;
      const watch = this.watches.get(notification.params.uri);
      if (!watch || watch.changed) return;
      watch.changed = true;
      this.notify(notification.params.uri);
    });
  }

  list() {
    return [...this.watches].map(([uri, watch]) => ({ uri, changed: watch.changed }));
  }

  set(uri: string, subscribe: boolean, signal?: AbortSignal): Promise<void> {
    const work = this.queue.then(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      const options = { signal: controller.signal, timeout: this.timeout };
      try {
        const existing = this.watches.get(uri);
        if (subscribe && existing) return;
        if (!subscribe) {
          if (!existing) return; // Never connect or replay a forgotten watch.
          if (existing.stream) await existing.stream.close();
          else await this.client.unsubscribeResource({ uri }, options);
          this.watches.delete(uri);
          return;
        }
        if (!this.client.getServerCapabilities()?.resources?.subscribe)
          throw failure("subscriptions_unsupported", { server: this.server, operation: "subscribe" });
        if (this.watches.size >= 50)
          throw failure("subscription_limit", { server: this.server, operation: "subscribe" });
        const watch: Watch = { changed: false };
        // Install before acknowledgment so early updates aren't lost.
        this.watches.set(uri, watch);
        try {
          if (this.client.getProtocolEra() === "modern") {
            watch.stream = await this.client.listen({ resourceSubscriptions: [uri] }, options);
            if (!watch.stream.honoredFilter.resourceSubscriptions?.includes(uri)) {
              await watch.stream.close();
              throw failure("subscriptions_unsupported", { server: this.server, operation: "subscribe" });
            }
            void watch.stream.closed.then(() => {
              if (this.watches.get(uri) === watch) this.watches.delete(uri);
            });
          } else await this.client.subscribeResource({ uri }, options);
          controller.signal.throwIfAborted();
        } catch (error) {
          this.watches.delete(uri);
          await watch.stream?.close().catch(() => {});
          // A timed-out legacy subscribe may already have taken effect. Cancel
          // best-effort, but never replay the subscription or infer success.
          if (this.client.getProtocolEra() === "legacy")
            await this.client.unsubscribeResource({ uri }, { timeout: this.timeout }).catch(() => {});
          throw error; // Ambiguous failures are never retried.
        }
      } finally {
        // A completed watch outlives the command's abort signal.
        signal?.removeEventListener("abort", abort);
        this.lifetime.signal.removeEventListener("abort", abort);
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async close(connected = true) {
    this.lifetime.abort(); // Suppress updates and cancel pending opens first.
    await this.queue;
    const watches = [...this.watches];
    this.watches.clear();
    await Promise.all(watches.map(async ([uri, watch]) => {
      if (watch.stream) await watch.stream.close().catch(() => {});
      else if (connected) await this.client.unsubscribeResource({ uri }, { timeout: this.timeout }).catch(() => {});
    }));
  }
}
