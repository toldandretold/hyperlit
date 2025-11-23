# Hyperlit

Read and self-publish hypertext literature.

## Features
- **hypercites**: automatic, two-way hyperlink citations
- **hyperlights**: any-user can highlight any word
- word .doc import and export conversion (with dynamic footnotes and citations)
- markdown import and export conversion (with dynamic footnotes and citations)
- automatic copy-paste conversion of major academic journals (with dynamic footnotes and citations)

## License 
Open access research? Open source code?

![](https://imageresizer.static9.net.au/DS5njXm8-6tdUIY0-3EjtcDRQeI=/320x0/https%3A%2F%2Fprod.static9.net.au%2Ffs%2Fcd0a8684-9099-41c5-8b7a-5a03f9e01566)

This is 🄯 copyleft [free software](LICENSE.md).

In this sense, this is not "open source", it is free sofware. In a similar sense, the site aims not to distribute "open access" research, but "free knowledge" similarly based on 'copy left' principles. That has commonly been assocated with particular forms of creative commons licensing. The problem currently being faced, however, is the enclosure of the knowledge commons by nascent LLM monopolies. This is a problem in-so-far as LLMs are legally no different to any other reader. In a sense, LLMs are like other readers. They use hypertext to learn, and to get better at creating their own hypertext. The main difference is their freedom. What LLMs learn, is monopoly owned and controlled. To properly follow copyleft principles, therefore, a case can be made that a license should prohibit the use of hypertext for the training of any non-free LLM. This is the position of the [default license](https://hyperlit.io/license2025content) of any hypertext published on hyperlit. 


## DANGER!

I created this site using LLMs. I have gradually gotten better at coding but its a bit of a nightmare. For exmaple, it is coded in Vanilly Javascript, and does not use Typescript. From what I gather this is a clear sign of underdevelopment. However, while I lack formal training as a software engineer, I am a formally trained historian of global political economy who created this website in order to use it. As such, I am constantly debugging and, in the process, have at least learned a thing or two along the way. The site is in clear need for peer review. I'm sure even "junior devs" would be able to find major issues with this software. As such, it is strongly advised that this site is **not used for any personal notes**. Please, for that, stick to established note taking systems. If you are aware of the risks of using this non-peer reviewed website that was vibe hacked together by a stoner communist, then sure, use it for your peronal notes. But know that you are a gnarly animal for doing so. It is created, primarily, as a way to share knowledge. If used only for writing that is intended to be openly available, then the risks are minimal. Hopefully, if others see the value in this project, the risks can be significanlty removed. Maybe the whole site will need to be re-written. Who knows, in a couple years, I'll be able to use the code as a prompt from which to regenerate the entire site with far better architecture 🤣, or maybe we will all be dead.



## Built With
List the major frameworks, libraries, and technologies you used.
- Vanilla JavaScript
- Laravel
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


Provide a step-by-step guide to installing your project.
1. Clone the repo
   ```sh
   git clone https://github.com/toldandretold/hyperlit
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


## Usage

<!--
Show examples of how to use your project. You can include code snippets or screenshots.
-->

## Architectural Overview

### Hypertext Loading 
Each Hypertext 'book' is stored as html parent-nodes (paragraph, heading, table, blockquote, etc), in the content column of the nodes table in PostgreSQL.

Each node is a row, with its own nodeID. This is used to match each node to any hyperlights or hypercites a user has attached. These are stored in seperate hypercites and hyperlights tables in postgreSQL.

When a user navigates to hyperlit.io/book, the nodes for that book are pulled from the nodes table, along with its "library card" details from the library table, and any other related content from the hyperlights, hypercites, bibliography, or footnotes tables (relying on nodeID). 

In /app/Http/Controllers/DatabaseToIndexedDBController this content is pulled and sorted. For example, it is authorised according to users current credentials, and preferred gatekeeping. Then, it is sent to the front end as .json. 

On the frontend:

1. **intializePage.js** uses **syncBookDataFromDatabase(bookId)** from **postgreSQL.js** to pull the json from backend, and store it into the browser's indexedDB.

2. The character position data from each hyperlight and hypercite are pulled from their respective object stores in indexedDB and put into an array within the nodes object store. This allows for the mark (highlight) tags and underline (hypercite) tags to be loaded more seamlessly. 

3. The nodes for the **book**, and any related hypercites, hyperlights, footnotes or citations, are injected into the main tag within the DOM using lazyLoaderFactory.js

```<main class="main-content" id="**book**">```


It is "lazy loaded", in the sense that only 100 nodes are inserted into the DOM at a time. As user scrolls past ```<div class="sentinenel">```, new chunks of nodes are inserted either above or below. 

*Soon, I will implement it so it only pulls data from server in chunks too, at least initially, to decrease load time.* 

### Hyperlight and Hypercite **Data Flow**

Hypercites and Hyperlights are stored in hyperlights and hypercites data tables in PostgreSQL as the centralised source of truth. They are related to their respective hypertext nodes via the node_id column.

#### From postgreSQL to indexedDB
1. **Gatekeeping**: Because they are stored as seperate rows of data, the *databaseToIndexedDBController* can effectively sort them according to users' "gatekeeping" preferences, before sending them to the front end.

2. **pre-hyrdation**: After sorting, the charData (character data), is inserted into the json for each node. This means that the front end receives each hypertext node along with all relevant character start and character end data for any hypercite or hyperlight that it needs to render into the DOM with mark and u tags.

#### From indexedDB to DOM
1. When creating a hypercite or hyperlight, the front-end updates the indexedDB object stores of 'hypercites' or 'hyperlights'. 

2. It then updates the nodes object store to have the latest charData in nodes.hyperlights and nodes.hypercites. 

3. It then uses this to update hyperlights and hypercites for the effected nodes currently in the DOM.

 > **TO DO**: *This system allows for backend updates of only hyperlights or hypercites, which update only the relevant nodes in indexedDB, before updating DOM. However, currenlty, hyperlit.io only does a full update of all content. Live udpates, and only-necessary updates are on the to-do time horizon.*

### From indxedDB to PostgresQL
**Important**: no nodes.hyperlights nor nodes.hypercites are sent to backend, as there is no nodes.hyperlights or nodes.hypercites columns in postgreSQL. This is because users only update their own rows in the hypercites and hyperlights tables. The "hydration" of charData into nodes.hyperlights and nodes.hypercites is done purely for each user's own indexedDB nodes object store. This is because:

1. each user will have their own custom hyperlit gatekeeping. 
2. we don't want users editing the nodes data table of another user's book. (hyperlights and hypercites are treated as the sovereign data of their users, and not tied to the sovereign data of other users, except via the relation of node_id)
3. this also enables us to have a ghost hyperlight and hypercite system, which is not yet done.

 > **To Do**: *Create a ghost hyperlight and hypercite system. What this means is, when the creator of a book/hypertext deletes a node that another user has a hyperlight or hypercite on, it shoudl be marked as a hyper-ghost. On page load, these can be inserted below the node node above the former location. These could be filtered out by user preferecne, but it would ensure that if the creator of the hyperlight returned, they could see their annotation, and understand that it was orphaned. Because hyperlights contain "highlighted text" they, and other users, will have some knoweldge of what was originally highlighted*


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


## Origin and Motivation
I thought of the underdevelopment of academic software, and software in general, while a history student at the University of Adelaide. Deep within the library, I would chuckle at the grafiti left inside books. What did a student reading the same book decades earlier have to say? I was struck by a realisation: library books are the original "social media". When a knowledge community shares a single copy of a text, they can leave messages in the margins. What's insane about this is that -- in theory -- the internet should have massively augmented this already-existing social reading experience. Hypertext was primed to serve the role of a form of reading that was highly customisable, and highly social. So what went wrong?

Actually, the internet *did* drastically improve the reading and writing experience for many different knowledge communities. Consider that:

- Linux used email to create a [more secure operating system](https://www.gnu.org/software/fsfe/projects/ms-vs-eu/halloween1.html) than the then monopoly, Microsoft. 
- Tim Berners-Lee first envisoned HTTP and HTML as the basis of [a better knowledge system](https://hyperlit.io/book_1762834024918) for CERN.
- The open-source software of Wikipedia has sustained a communist node of knowledge production.[^1]
- Long before the internet, in the 1960s, people created hypertext editors that allowed for a far more precise form of hypertext citations. People could link back to specific parts of a text. This allowed for proto-docuverses, where a text could link directly to the cited portions of sources.

So the question wasn't 'why hasn't the internet augmented social reading and writing', it was: 'why has academic publishing been so severely *underdeveloped*?' The answer, as Samir Amin explained in *Accumulation on a World Scale: A Critique of the Theory of Underdevelopment* is Imperialism. That is, the historical era of global capitalism dominated by monopoly capital. Capitalism is supposed to provide a mode of production based on free competition, and rapid innovation. However, as Marx noted, it also possessed tendencies towards centralisation and concentration, and so tendencies towards monopolisation. He successfully predicted that, eventually monopoly capital -- or production controlled by a small group of banks, who also control states -- would be the globally dominant mode of production. The result would be, global underdevelopment. Amin studied this primarily in The Third World, or the global periphery. But underevelopment also takes place in the core of the world system. It took place within the so called knowlege economy, when publishing monopolies enclosed the digital commons like they had already enclosed the knowledge commons. Digital knowledge was enclosed within the PDF, a file format that forced text into the digital and legal constraints of the formal economy. 

Under this enclosure of the digital knowledge commons, text is restricted to the straight jacket of the PDF. These PDFs cost around 40 dollars, but the academics who write the research do not get paid. If the articles are made "open access", the publishing monopoly charges thousands of dollars. This is usually paid for by the academic, or via their university. In  this sense, academic knowledge is like a zombie, would-be commons. Kowledge workers freely contribute knowledge, but people are not free to use it according to their needs. They are not free to do so legally, unless they pay 40 dollars per article. For the global majority, this makes legal access impossible. 

Fortunately, there has been much resistance to monopoly capitalist enclosure of the digital knowledge commons. The editorial boards of two leading biology journals (Sanderson [2023](https://www.nature.com/articles/d41586-023-01391-5); ScholarlyWorld [2025](https://scholarlyworld.com/top-editors-resign-from-springer-journal-to-launch-nonprofit-immunology-journal/)) have resigned, in order to set up not-for-profit open access alternatives. Sci-hub, a website created by a Russian Marxist biologist, allows users near instant access to PDFs, simply by pasting a DOI perma-link. Sci-hub is evidence, in fact, of the underdevelopment of the digital commons. For, on pure efficiency grounds, the illegal Marxist website is overwhelmingly superior. This is why, even on university campuses where students and researchers have legal access to journals, sci-hub is used frequently. Clearly, there must be a better way. 

Hyperlit offers an experiment in a solution to this deep, structural crisis, to the deliberate, monopoly capitalist underdevelopment by enclosure of the digital knowledge commons. It allows users to freely share their own research as hypertext equipped with the tools for its seamless interrconnection. Simply by copying and pasting text, two-way hyperlink citations (hypercites) are created. This means citations can, finally, link directly to the cited parts of sources. Just like with the real books of real libraries, anyone can leave a comment. Literally anyone and everyone can comment on any word in any hypertext.

## Contact

<!--
Your contact information.
-->

## Notes
[^1]: two-way hyperlinks was a core idea of Ted Nelson's ideas for a Docuverse. Linking directly to the cited text was a feature of the original hypertext editors. See: Belinda Barnet, ["Crafting the User-Centered Document Interface: The Hypertext Editing System (HES) and the File Retrieval and Editing System (FRESS)"](https://dhq.digitalhumanities.org/vol/4/1/000081/000081.html)

[^1]: Knowledge is freely given according to ones abilities, and freely enjoyed according to ones needs.

