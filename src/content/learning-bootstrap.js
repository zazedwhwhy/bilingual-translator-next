void import(chrome.runtime.getURL("src/content/learning.js"))
  .then((m) => m.startLearning())
  .catch((error) =>
    console.error("Learning initialization failed", error.message),
  );
