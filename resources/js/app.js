console.log('App.js is loaded');

export const mainContentDiv = document.getElementById("main-content");

export const markdownContent = ""; // Store Markdown globally



export const book = mainContentDiv.getAttribute("data-book");


console.log("mainContentDiv:", mainContentDiv);
console.log("book:", book);