
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

export const book = document.querySelector('.main-content').id;


export const markdownContent = ""; // Store Markdown globally




console.log("book:", book);



