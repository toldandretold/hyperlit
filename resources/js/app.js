
console.log('App.js is loaded');

if ("serviceWorker" in navigator) {
	
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/build/serviceWorker.js")
      .then((registration) => {
        console.log(
          "Service Worker registered successfully with scope:",
          registration.scope
        );
      })
      .catch((error) => {
        console.error("Service Worker registration failed:", error);
      });
  });
}

export const mainContentDiv = document.getElementById("main-content");

export const markdownContent = ""; // Store Markdown globally



export const book = mainContentDiv.getAttribute("data-book");


console.log("mainContentDiv:", mainContentDiv);
console.log("book:", book);



