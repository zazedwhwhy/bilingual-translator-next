export class LiveBudget {
  constructor() {
    this.maximumCalls = 2;
    this.calls = 0;
    this.spentUpperRmb = 0;
    this.reservedRmb = 0;
    this.limitRmb = 4.5;
    this.authorizedRmb = 5;
  }
  // Full official 1,048,576-token context reserved at peak USD input rate;
  // output 4096 at peak USD rate; conversion ceiling 14 CNY/USD, >2x CNY pricing.
  static worstRmb = ((1048576 * 0.3 + 4096 * 1.2) / 1000000) * 14;
  admit(body, bytes) {
    if (
      body.model !== "deepseek-flash" ||
      body.max_tokens !== 4096 ||
      body.thinking?.type !== "disabled" ||
      body.stream !== false ||
      body.tools ||
      !Array.isArray(body.messages) ||
      body.messages.length !== 2 ||
      bytes > 8000
    )
      throw Error("LIVE_REQUEST_REJECTED");
    if (
      this.calls >= this.maximumCalls ||
      this.spentUpperRmb + this.reservedRmb + LiveBudget.worstRmb >
        this.limitRmb
    )
      throw Error("LIVE_BUDGET_EXHAUSTED");
    this.calls++;
    this.reservedRmb += LiveBudget.worstRmb;
    return { settled: false };
  }
  settle(ticket, usage) {
    if (ticket.settled) throw Error("LIVE_TICKET_ALREADY_SETTLED");
    ticket.settled = true;
    const fields = ["prompt_tokens", "completion_tokens", "total_tokens"];
    if (
      !usage ||
      fields.some((k) => !Number.isSafeInteger(usage[k]) || usage[k] < 0) ||
      usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens ||
      usage.prompt_tokens > 1048576 ||
      usage.completion_tokens > 4096
    )
      return false;
    const upper =
      ((usage.prompt_tokens * 0.3 + usage.completion_tokens * 1.2) / 1000000) *
      14;
    this.reservedRmb -= LiveBudget.worstRmb;
    this.spentUpperRmb += upper;
    return true;
  }
  snapshot() {
    return {
      calls: this.calls,
      maximumCalls: this.maximumCalls,
      authorizedRmb: this.authorizedRmb,
      internalLimitRmb: this.limitRmb,
      spentUpperRmb: this.spentUpperRmb,
      reservedRmb: this.reservedRmb,
      worstCasePerRequestRmb: LiveBudget.worstRmb,
    };
  }
}
