import { WebhookClient, EmbedBuilder } from "discord.js";
import { ArbitrageOpportunity, NetworkConfig } from "../types";

export interface TradeNotification {
  type: "LOW_BALANCE" | "BOT_START" | "CUSTOM";
  network?: NetworkConfig | string;
  tokenIn?: string;
  tokenOut?: string;
  amount?: string;
  txHash?: string;
  error?: string;
  opportunity?: ArbitrageOpportunity;
  balances?: {
    [key: string]: {
      amount: string;
      previousAmount?: string;
      usdValue?: string;
      change?: string;
    };
  };
  gasUsed?: string;
  actualProfit?: string;
}

export class DiscordNotificationService {
  private webhook: WebhookClient | null = null;
  private isEnabled: boolean = false;

  constructor(webhookUrl?: string) {
    if (webhookUrl) {
      try {
        this.webhook = new WebhookClient({ url: webhookUrl });
        this.isEnabled = true;
        // console.timeLog("Discord notifications enabled");
      } catch (error) {
        this.isEnabled = false;
      }
    } else {
      this.isEnabled = false;
    }
  }

  async sendNotification(notification: TradeNotification): Promise<void> {
    if (!this.isEnabled || !this.webhook) {
      return;
    }

    try {
      const embed = this.chooseNotification(notification);
      await this.webhook.send({ embeds: [embed] });
    } catch (error) {}
  }

  private chooseNotification(notification: TradeNotification): EmbedBuilder {
    const embed = new EmbedBuilder();
    const timestamp = new Date().toISOString();

    switch (notification.type) {
      case "LOW_BALANCE":
        return this.createLowBalanceAlert(notification, embed, timestamp);

      case "BOT_START":
        return embed
          .setTitle("🚀 ARBITRAGE BOT STARTED")
          .setDescription(
            `Bot is now running and monitoring for opportunities.\n\n**Wallet Address:** \``
          )
          .setColor(0x00ff00) // Green, for bot start
          .setTimestamp();

      default:
        return embed
          .setTitle("Unknown Notification")
          .setColor(0x808080)
          .setTimestamp();
    }
  }

  private createLowBalanceAlert(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    const balances = notification.balances!;
    const fields = Object.entries(balances).map(([token, data]) => {
      let value = `Current: ${data.amount}`;
      if (data.usdValue) {
        value += `\n≈ $${data.usdValue}`;
      }
      return {
        name: `💰 ${token}`,
        value: value,
        inline: true,
      };
    });

    return embed
      .setTitle("🤖 Low Balance alert")
      .setColor(0x0099ff) // Blue, for low balance alerts
      .addFields(fields)
      .setFooter({ text: `Started at ${timestamp}` })
      .setTimestamp();
  }

  // Just in case most probably will not use this
  async sendCustomMessage(
    title: string,
    description: string,
    color: number = 0x0099ff
  ): Promise<void> {
    if (!this.isEnabled || !this.webhook) {
      return;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

      await this.webhook.send({ embeds: [embed] });
    } catch (error) {}
  }

  // Method to send startup notification
  async sendStartupNotification(walletAddress: string): Promise<void> {
    await this.sendCustomMessage(
      "🚀 ARBITRAGE BOT STARTED",
      `Bot is now running and monitoring for opportunities.\n\n**Wallet Address:** \`${walletAddress}\`\n**Status:** Online ✅`,
      0x00ff00
    );
  }

  // Method to send shutdown notification
  async sendShutdownNotification(): Promise<void> {
    await this.sendCustomMessage(
      "🛑 ARBITRAGE BOT STOPPED",
      "Bot has been shut down.",
      0xff0000
    );
  }
}
