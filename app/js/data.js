// Explicit demo-mode fixtures and shared display defaults. Live model identities come from the gateway.
// No logic in this file: plain objects and constants only.

// Hardware
export const GPU_NAME = "RTX 5070";
export const GPU_TOTAL_GB = 12;
export const SYS_TOTAL_GB = 32;

// Engine constants (simulated memory and speed)
export const OTHER_APPS_GB = 0.7;     // graphics memory used by other programs
export const OVERHEAD_GB = 1.0;       // fixed cost of a loaded model
export const KV_GB_PER_1000_TOKENS = 0.34; // conversation cache per 1,000 tokens of context
export const FIT_TIGHT_LIMIT = 0.85;  // share of the card: below this the model fits
export const FIT_SPILL_LIMIT = 1.0;   // share of the card: above this the model spills
export const FULL_WPS = 30;           // words per second with every layer on the card
export const HALF_SPILLED_WPS = 3;    // words per second with half the layers in system memory
export const DEFAULT_CONTEXT_TOKENS = 6100; // context reserved at start, 6.1K

// Model files found in the models folder
export const models = [
  { id: "qwen3.5-9b-q4km", name: "qwen3.5-9b", version: "Q4_K_M", sizeGB: 5.6, layers: 40, maxContext: 32768, failsToLoad: false },
  { id: "qwen3.5-9b-q6k", name: "qwen3.5-9b", version: "Q6_K", sizeGB: 7.4, layers: 40, maxContext: 32768, failsToLoad: false },
  { id: "qwen3.5-9b-q8", name: "qwen3.5-9b", version: "Q8_0", sizeGB: 9.5, layers: 40, maxContext: 32768, failsToLoad: false },
  { id: "qwen3.8-27b-q3km", name: "qwen3.8-27b", version: "Q3_K_M", sizeGB: 13.2, layers: 64, maxContext: 65536, failsToLoad: true },
  { id: "qwen3.8-27b-q4km", name: "qwen3.8-27b", version: "Q4_K_M", sizeGB: 17.0, layers: 64, maxContext: 65536, failsToLoad: false },
];

// Quick-switch slots (Ctrl+1 to Ctrl+4). modelId null means an empty slot.
export const slots = [
  { slot: 1, modelId: "qwen3.5-9b-q4km" },
  { slot: 2, modelId: "qwen3.8-27b-q4km" },
  { slot: 3, modelId: "qwen3.5-9b-q6k" },
  { slot: 4, modelId: null },
];

// Chat
export const conversations = [
  { id: "c1", title: "Quantization trade-offs", model: "qwen3.5-9b", time: "now", group: "Today" },
  { id: "c2", title: "Explain a binary search bug", model: "qwen3.5-9b", time: "14:02", group: "Today" },
  { id: "c3", title: "Rewrite cover letter opening", model: "qwen3.8-27b", time: "11:47", group: "Today" },
  { id: "c4", title: "Kidney filtration, step by step", model: "qwen3.5-9b", time: "Thu", group: "Earlier this week" },
  { id: "c5", title: "Regex for US phone numbers", model: "qwen3.8-27b", time: "Thu", group: "Earlier this week" },
  { id: "c6", title: "Plan a week of dinners", model: "qwen3.5-9b", time: "Wed", group: "Earlier this week" },
  { id: "c7", title: "River crossing puzzle", model: "qwen3.8-27b", time: "Tue", group: "Earlier this week" },
];

export const chatMessages = [
  { role: "user", text: "What does Q4_K_M mean in a model's file name?" },
  {
    role: "model",
    model: "qwen3.5-9b",
    text: "It names the compression recipe. Q4 means each number in the model is stored in about four bits where the original used sixteen. K is the method, which packs numbers into small blocks that each get their own scale. M is the medium option, which keeps a few sensitive parts of the model at higher precision.",
    stats: { words: 58, seconds: 1.9, wordsPerSecond: 30.5 },
  },
];

export const chatSettings = ["temp 0.7", "top-p 0.9", "max 1024"];

// Text the simulated model streams when you send a prompt
export const cannedReply = "A model is a very large table of numbers. Compression stores each number with fewer bits, so the file is smaller and more of it fits on the graphics card. Speed comes mostly from that fit. Each word the model writes requires reading the whole table once, so a smaller table means less memory to move per word, and nothing has to spill over into slower system memory. The cost is rounding. Every number is nudged to the nearest value the smaller format can hold, and those small errors add up across billions of numbers. Down to about four bits per number the loss is slight. Below that it gets worse. That is why a Q4 file of a 9B model runs well on a 12 GB card while the Q8 file does not: the Q8 file leaves no room for the conversation, so part of it has to live in system memory, and every word then waits on the slower path. Quality falls more slowly than size at first. Going from sixteen bits to eight is almost free, eight to five costs a little on hard reasoning, and four bits is where most people stop, because the model is less than a third of its original size and still answers nearly as well. Three bits and below start to show: the model forgets details, loses track of long instructions and makes more arithmetic slips. The best way to choose is to run the same questions on two versions and compare, which is what the Tests and Arena screens are for.";


// Tests: two runs, six question types, 20 questions each. Scores are counts right out of 20.
export const testRuns = [
  {
    id: 14,
    when: "today 14:32",
    model: "qwen3.5-9b",
    version: "Q4_K_M",
    totalMinutes: 11.7,
    peakGB: 9.6,
    averageWordsPerSecond: 30.2,
    byType: [
      { type: "Logic", right: 14, total: 20, wordsPerSecond: 28.9 },
      { type: "Math", right: 15, total: 20, wordsPerSecond: 31.0 },
      { type: "Science", right: 17, total: 20, wordsPerSecond: 30.4 },
      { type: "Coding", right: 13, total: 20, wordsPerSecond: 29.1 },
      { type: "Reading", right: 18, total: 20, wordsPerSecond: 31.6 },
      { type: "Following instructions", right: 17, total: 20, wordsPerSecond: 30.2 },
    ],
    missedCount: 26,
    missed: [],
  },
  {
    id: 11,
    when: "Tue",
    model: "qwen3.8-27b",
    version: "Q4_K_M",
    totalMinutes: 114,
    peakGB: 11.6,
    averageWordsPerSecond: 3.0,
    byType: [
      { type: "Logic", right: 16, total: 20, wordsPerSecond: null },
      { type: "Math", right: 17, total: 20, wordsPerSecond: null },
      { type: "Science", right: 18, total: 20, wordsPerSecond: null },
      { type: "Coding", right: 16, total: 20, wordsPerSecond: null },
      { type: "Reading", right: 18, total: 20, wordsPerSecond: null },
      { type: "Following instructions", right: 17, total: 20, wordsPerSecond: null },
    ],
    missedCount: 18,
    missed: [],
  },
];

export const settings = {
  modelsFolder: "C:\\Models",
  idleUnloadMinutes: 10,
  warnBeforeFitFail: true,
  speedInWords: true,
};
