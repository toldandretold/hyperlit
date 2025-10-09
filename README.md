# Hyperlit

Read and self-publish hypertext literature.

## About The Project

- Academic publishing is dominated by a handful of monopolies.

- Hyperlit offers a "free software" alternative. 

- By focusing on hypertext (that is, not PDF), the goal is to give academic publishing the full promise of the early internet.

A text does not *need* to be "academic", or have citations, to be shared on Hyperlit. That is just my (toldandretold's) initial focus, because I am a historian. 

I wanted a way to automatically generate two-way hyperlink citations, or what I have been calling hypercites. This is not a new idea.[^1] I just wanted to be able to use the idea. I want to publish my own work, and read others' work, in a system *like* wikipedia but optimised for academic citations. Clicking a citatin should take me direclty to the originally cited text in a hypertext version of the source. When reading a source, i should be able to see which parts have been cited, and click to go to those citations, in hypertext versions of those sources.

The question is how to make the process of creating these hyper-cites easy. In its simplest form, Hyperlit solves this by allowing to just copy text from one book and pastes it in another. The pasted quote is automatically linked back to the cited text, and the cited text to the citation. This allows people to freely move between either end of a citation.

In this way, academic citations become like the two-way links that were originally intended to form a *Docuverse*. I believe that global knowledge production is in desperate need for a "free software" docuverse. 

For users who *don't care* about hyper-citing, there is also social highligting, or hyper-lighting. The idea for this is more simple. I just want users to be able to "grafitti" hypertext like real readers already do to real books in real libraries. It always bothered me that real books were, because of illegal grafitti, *more social* than most ebooks. Hyperlit solves this by allowing multi-user highlits to overlap. The more a text is highlighted, the more opaque its <mark> tag (highlight) is. 

If a user clicks on a piece of text with multiple highlights, the .hyperlit-container <div> opens, showing all the annotations. This applies to cited text, and all citations too. Whatever "meta content" a user clicks on, is all put into the .hyperlit-container. If a footnote has been hyper-cited and hyper-lighted, and a user clicks it, the .hyperlit-container opens to show the content of the footnote, a link to the citation, and the annotation associated with the highlight. 


## Key Features

<!--
List the major features of your application.
- Feature 1
- Feature 2
- Feature 3
-->

## Built With

List the major frameworks, libraries, and technologies you used.
- Laravel
- Vanilla JavaScript
- IndexedDB
- PostgreSQL
- Rangy highlighter


## Getting Started

<!--
Instructions on how to get a local copy up and running.
-->

### Prerequisites

<!--
List any software or tools that need to be installed before someone can run your project.
e.g., npm, composer, a specific version of PHP, etc.
-->

```sh
npm install npm@latest -g
```

### Installation

<!--
Provide a step-by-step guide to installing your project.
1. Clone the repo
   ```sh
   git clone https://github.com/your_username/your_project.git
   ```
2. Install NPM packages
   ```sh
   npm install
   ```
3. Install Composer packages
   ```sh
   composer install
   ```
4. Copy `.env.example` to `.env` and configure your environment variables.
-->

## Usage

<!--
Show examples of how to use your project. You can include code snippets or screenshots.
-->

## Architectural Overview

It is in the lazyloaderfactory, because this is the system that controls the input nad output of all all hypertext from the local storage of indexedDB and the DOM (that is viewable from within the elements tab of the web inpsector of this browser.)

The lazyily-loaded hypertext of each "book" is initialized in one place. Initializing link listeners and coordinating the SPA/link routing that these trigger is done here. This makes it easier to see that everything for the hypertext, including its *connections* with other hypertext, is all safely created and destroyed. Otherwise, the SPA system quicly builds up link listeners that were, for example, set up for a previous book. I quickly learned about this issue when I moved from a traditional system where pages are refreshed after each page navigation. I believe this kind of issue is probably solved far easier by relying on a framework.

In early stages, like prototyping the single/simple mechanisms that my non-developer mind could fathom, vanilla js was the most effective way for an LLM to get me the results I needed. I did discuss with it the advantages of using, for example, react. If I started again I would use Solid js. That seems pretty dope and I think it might be something I do at some stage. I honestly don't know if my code is, from a non-vibe-hacked perspective, total trash.

If you think so and know how I can fix it, please let me know or help. Much thanks if so.

It is possible to set it up so multiple books are open at once, in two different `<div class="main-content" id="bookId"></div>` in the same DOM. For now, each book is destroyed and recreated on each SPA navigation, from one book to another.

Some link transition speed advantages might come from this, but it would introduce the need for "horizontal", or book-shelf level, lazy loading management. Just as we currently:
- load hypertext from idnexedDB into the DOM in chunks
- remove and add new chunks as user scrolls up or down

Similarly, we would need to:
- load books into .main-content divs as user navigates to them
- remove books from .main-content divs as user navigates farther and farther away from them.

In other words, only a certain number of books would be loaded into .main-content divs at one time, and -- within those -- only a certain amount of hypertext chunks would be loaded into DOm. The presumed benefits of this would be far quicker hypercite-navigation between books that are all in the DOM already. It would also be great for back and forward swiping, as the hypertext-chunks from previous hypere-cite clicks would already be loaded into DOM and, most likely, with the actual hypertext-chunks scrolled-to the exact position user needs. If the book was no longer in the DOM, it can still, just as now, be quicly lazyloaded in from either browser cache or indexedDB. Unless its timestamp is out-of-date, in which case the book's hypertext is loaded in from the database on the server.

This is another area with much room for efficiency gains. Currently, if only a part of a book has been updated, that signals a timestamp change for the "library card" of the book, held in the library database under: citationID.

That means the entire hypertext is re-loaded from server, even if it only *needs* to update, for example:
- one node or chunk of nodes of hypertext
- just some highlights (which are stored as meta-data in the database for each node (like paragraph, heading, or blockquote tag)).

To introduce this, I would need to create a new laravel controller, like UpdateManagerController.php. Instaed of doing a timestamp check just before initialization, the front-end would request an update check. It would then receive notification of what parts of the page would need to be udpated.

This could be asynchronous, meaning the page loads as though no updates were needed, within reason. For example, it can get up to the point of injecting chunks, before it needs to know if any updates of those specific chunks exist. If the chunk that needs updating is not needed in the DOM, that is most easy. Just update it in the indexedDB and refresh the lazyLoaderManager's cache-thingAmagig (it needs to know when indexedDB has been udpated apparently...)

This is important to get right as, once it is in place, it will be possible to add on to it the ability for live hyperlighting updates. For example, if you are reading a book and someone highlights the paragraph you are reading, it can appear as you are reading. This is something -- obviously -- that users could disable.

## Roadmap

<!--
List the features you plan to implement in the future. This shows the direction of the project.
- [ ] Feature A
- [ ] Feature B
- [ ] Sub-feature C
-->

## Contributing

<!--
Explain how others can contribute to your project. You can mention:
- The process for submitting pull requests.
- How to report bugs.
- Your coding standards.
You can also reiterate your openness to feedback here.
-->

## License

<!--
State the license for your project. E.g., "Distributed under the MIT License."
-->

## Contact

<!--
Your contact information.
-->

## Notes
[^1]: two-way hyperlinks was a core idea of Ted Nelson's ideas for a Docuverse. Linking directly to the cited text was a feature of the original hypertext editors. See: Belinda Barnet, ["Crafting the User-Centered Document Interface: The Hypertext Editing System (HES) and the File Retrieval and Editing System (FRESS)"](https://dhq.digitalhumanities.org/vol/4/1/000081/000081.html)
