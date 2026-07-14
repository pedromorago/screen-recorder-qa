"use strict";

const statusEl = document.getElementById("status");
const retryBtn = document.getElementById("retry");

async function ask() {
  statusEl.className = "";
  statusEl.textContent = "Requesting permission…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    statusEl.className = "ok";
    statusEl.textContent = "Microphone allowed. This tab will close itself.";
    setTimeout(() => {
      chrome.tabs.getCurrent((tab) => tab && chrome.tabs.remove(tab.id));
    }, 1500);
  } catch (e) {
    statusEl.className = "fail";
    statusEl.textContent =
      "Permission was not granted (" +
      (e.name || "error") +
      "). Click the lock or camera icon in the address bar, allow the microphone and retry.";
  }
}

retryBtn.addEventListener("click", ask);
ask();
