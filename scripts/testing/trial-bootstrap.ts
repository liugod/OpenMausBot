export function needsTrialAssistant(bots: readonly { defaultBot?: unknown }[]): boolean {
  return !bots.some(bot => !bot.defaultBot);
}
