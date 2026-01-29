![hyperlit](/public/images/titleLogo.png)

# Hyperlit

Read and self-publish hypertext literature. 

[https://hyperlit.io](https://hyperlit.io)

## Why?

I am a historian. I made this site to publish research with two-way hyperlink citations.[^1]

I import sources to read. I cite by copying passages and pasting them into my own article.

This means readers of my work can be taken directly to the cited passages in the source material.

You might want to use it for something else.

## Features
- **hypercites**: automatic, two-way hyperlink citations (Copy text with hypercite button. Paste it. Hypercited!)
- **hyperlights**: any-user can highlight any word
- **word .doc** import and export conversion (with dynamic footnotes and citations)
- **markdown .md** import and export conversion (with dynamic footnotes and citations)
- **automatic copy-paste conversion** of major academic journals (with dynamic footnotes and citations)

## How to use?

**login/register** via top left button on homepage.

**create new book or import from file**: top-right [+] button on homepage.

**hyperlight** any text by selecting text, and pressing the colored square.

**hypercite** any text by selecting text, pressing the hypercite button. Then: paste it.

**publish a book** by clicking the cloudRef button (top right in reader/writer mode) and clicking the red lock button. 

**read an academic journal within hyperlit.io** by copy and pasting it. Most major journals will have their footnotes and citations rendered dynamically by default. Even if this is not an open access text, you can still read and cite it yourself legally (just don't publish it). If it **is** open access, publish it so others can read along with you, and compare notes!

## License 

This is copyleft [free software](LICENSE.md).

Users have full sovereignty of their data. 

By default, published work comes with a copyleft inspired license that aims to protect text from being used to train non-free LLMs. See: [default license](https://hyperlit.io/license2025content). Ironically, the LLM slave that wrote this license tells me that it is unlikely to be legally binding.

## WARNING!

I created this website using LLMs. I have gradually gotten better at programming, but I am still largely dependent on LLMs. I'm sure both lovers and haters of vibez will find fucked shit in this code. 

It is for this reason that it is stronlgy advised that the website is **not used for any personal notes**, or anything that you would not want leaked to the internet. This is intended for publishing "copyleft" writing that you want others to read freely.

That said, I am a historian of global political economy who created this website in order to use it. I am using it to write and publish, and hope that -- eventually -- it will become reliable enough for others' trust. Now, though, it is clearly in need of "peer review".

## Built With
List the major frameworks, libraries, and technologies you used.
- Vanilla JavaScript (I know... I should update to Typescript)
- Laravel
- IndexedDB
- PostgreSQL
- Rangy highlighter
- Python

## Getting Started **locally**

### Prerequisites

You need the following installed on your system:
- **PHP 8.2+** ([download](https://www.php.net/downloads))
- **Composer** ([download](https://getcomposer.org/download/))
- **Node.js 18+** and npm ([download](https://nodejs.org/))
- **PostgreSQL** ([download](https://www.postgresql.org/download/))

### Installation

1. **Clone the repository**
   ```sh
   git clone https://github.com/toldandretold/hyperlit.git
   cd hyperlit
   ```

2. **Install PHP dependencies**
   ```sh
   composer install
   ```

3. **Install Node.js dependencies**
   ```sh
   npm install
   ```

4. **Set up environment variables**
   ```sh
   cp .env.example .env
   ```

   > *The `.env` file is your local configuration (automatically excluded from git via `.gitignore`). You'll need to update the database credentials in the next step.*

5. **Generate application key**
   ```sh
   php artisan key:generate
   ```

   > *This creates a unique encryption key in your `.env` file. No manual editing needed for this step.*

6. **Set up database (PostgreSQL required)**

   First, create a PostgreSQL database (using pgAdmin, psql, or your preferred tool).

   Then open `.env` and update these lines with your actual database credentials:
   ```
   DB_DATABASE=hyperlit          # or whatever you named your database
   DB_USERNAME=your_username     # your PostgreSQL username
   DB_PASSWORD=your_password     # your PostgreSQL password
   ```

   > *PostgreSQL is required (the project uses JSONB and other PostgreSQL-specific features). The other DB settings (host, port) are already correct for a standard local PostgreSQL install.*

7. **Run database migrations**
   ```sh
   php artisan migrate
   ```

8. **Start the development servers**
   ```sh
   npm run dev:all
   ```

   This starts:
   - PHP server on http://localhost:8000
   - Queue worker
   - Vite dev server

   Visit http://localhost:8000 in your browser.

   **For mobile testing:** Use `npm run dev:network` instead. This makes the server accessible on your local network (e.g., http://192.168.1.x:8000) so you can test on phones/tablets.

### Alternative: Run servers separately

If you need more control:

```sh
# Terminal 1: PHP server
php artisan serve

# Terminal 2: Queue worker
php artisan queue:work

# Terminal 3: Vite dev server
npm run dev
```

### Commands useful for humans and LLMs

**View database schema:**
```sh
php artisan schema:dump
```
This creates a readable SQL schema file at `database/schema/pgsql-schema.sql` - useful for understanding the database structure without reading individual migration files. Both biological and artificial intelligence benefit from this.

**View application logs:**
Laravel logs are saved to `storage/logs/laravel.log` - check here for errors and debugging information.

**Other helpful commands:**
```sh
php artisan migrate:fresh    # Reset database and re-run all migrations
php artisan route:list       # View all registered routes
php artisan tinker           # Interactive PHP REPL with your app loaded
```

## Architectural Overview

### Hypertext Loading 
Each Hypertext 'book' is stored as html parent-nodes (paragraph, heading, table, blockquote, etc), in the content column of the nodes table in PostgreSQL.

Each node is a row, with its own nodeID. This is used to match each node to any hyperlights or hypercites a user has attached. These are stored in seperate hypercites and hyperlights tables in postgreSQL.

When a user navigates to hyperlit.io/book, the nodes for that book are pulled from the nodes table, along with its "library card" details from the library table, and any other related content from the hyperlights, hypercites, bibliography, or footnotes tables (relying on nodeID). 

In /app/Http/Controllers/DatabaseToIndexedDBController this content is pulled and sorted. For example, it is authorised according to users' current credentials, and preferred gatekeeping. Then, it is sent to the front end as .json. (this is currently slow. I will make it faster in future, by potentially injecting first chunk of nodes into blade view so it loads instantly, and so users don't need to download a whole book before the page loads).

On the frontend:

1. **intializePage.js** uses **syncBookDataFromDatabase(bookId)** from **postgreSQL.js** to pull the json from backend, and store it in the browser's indexedDB.

2. The character position data from each hyperlight and hypercite are pulled from their respective object stores in indexedDB and put into an array within the nodes object store. This allows for the <mark> (highlight) tags and <underline> (hypercite) tags to be loaded more seamlessly into the DOM.

3. The nodes for the **book**, and any related hypercites, hyperlights, footnotes or citations, are injected into the <main> tag within the DOM using lazyLoaderFactory.js

```<main class="main-content" id="**book**">```


4. It is "lazy loaded", in the sense that one "chunk" of 100 nodes is inserted into the DOM at a time. As user scrolls past ```<div class="sentinenel">```, new chunks of nodes are inserted either above or below. 

This ensures that the site is responsive and usable, even when reading a massive academic book filled with footnotes and hypercites 

### Hyperlight and Hypercite **Data Flow**

Hypercites and Hyperlights are stored in hyperlights and hypercites data tables in PostgreSQL as the centralised source of truth. They are related to their respective hypertext nodes via the node_id column.

#### From postgreSQL to indexedDB
1. **Gatekeeping**: Because they are stored as seperate rows of data, the *databaseToIndexedDBController* can effectively sort them according to users' "gatekeeping" preferences, before sending them to the front end.

2. **pre-hyrdation**: After sorting, the charData (character data), is inserted into the json for each node. This means that the front end receives each hypertext node along with all relevant character-start and character-end data for any hypercite or hyperlight that it needs to render into the DOM with <mark> and <u> tags.

#### From indexedDB to DOM
1. When creating a hypercite or hyperlight, the front-end updates the indexedDB object stores of 'hypercites' or 'hyperlights'. 

2. It then updates the nodes object store to have the latest charData in nodes.hyperlights and nodes.hypercites. 

3. It then uses this to update hyperlights and hypercites for the effected nodes currently in the DOM.

 > **TO DO**: *The system currently updates according to a timestamp check of both text-node content, and hyperlights/hypercites. For example, if a user highlights text, it only updates the hyperlight meta-data. It doesn't unecessarily re-pull all the text nodes.
>
> However, I will eventually update it so it only needs to update the specifcally changed nodes/highlights/hypercites. This will reduce the amound of data server has to send and receive.*

### From indxedDB to PostgresQL
**Important**: no nodes.hyperlights nor nodes.hypercites are sent to backend, as there is no nodes.hyperlights or nodes.hypercites columns in postgreSQL. This is because users only update their own rows in the hypercites and hyperlights tables. The "hydration" of charData into nodes.hyperlights and nodes.hypercites is done purely for each user's own indexedDB nodes object store. This is because:

1. each user will have their own custom hyperlit gatekeeping. 
2. we don't want users editing the nodes data table of another user's book. (hyperlights and hypercites are treated as the sovereign data of their users, and not tied to the sovereign data of other users, except via the relation of node_id)
3. this also enables us to have a ghost hyperlight and hypercite system, which is not yet done.

 > **To Do**: *Create a ghost hyperlight and hypercite system. When the creator of a book/hypertext deletes a node that another user has a hyperlight or hypercite on, it should be marked as a hyper-ghost. On page load, these could be inserted below the node above the former location. These could be filtered out by user preferecne, but it would ensure that if the creator of the hyperlight returned, they could see their annotation, and understand that it was orphaned. Because hyperlights contain "highlighted text" they, and other users, will have some knoweldge of what was originally highlighted*


## Roadmap

1. Hyperlight-ghost system.
2. Version control.
3. Pre-inject first chunk for faster load time.
4. More security vulnerability testing
5. Footnote / hyperlight annotations are treated as text-nodes so  that they too can be highlighted and hypercited.
6. Update crucial user settings, like change password. Two-factor auth or passkey. 

## Contributing

Please use it. Let me know what you use it for. Ask for help. Let me know what sucks.

## Origin and Motivation
I thought of the underdevelopment of academic software, and software in general, while a history student at the University of Adelaide. Deep within the library, I would chuckle at the grafiti left inside books. What did a student reading the same book decades earlier have to say? I was struck by a realisation: library books are the original "social media". When a knowledge community shares a single copy of a text, they can leave messages in the margins. What's insane about this is that -- in theory -- the internet should have massively augmented this already-existing social reading experience. Hypertext was primed to provide a form of reading that was highly customisable, and highly social. So what went wrong?

Actually, the internet *did* drastically improve the reading and writing experience for many different knowledge communities. Consider that:

- Linux used email to create a [more secure operating system](https://www.gnu.org/software/fsfe/projects/ms-vs-eu/halloween1.html) than the then monopoly, Microsoft. 
- Tim Berners-Lee first envisoned HTTP and HTML as the basis of [a better knowledge system](https://hyperlit.io/book_1762834024918) for CERN.
- The open-source software of Wikipedia has sustained a communist node of knowledge production.[^2]
- Long before the internet, in the 1960s, people created hypertext editors that [allowed for a far more precise form of hypertext citations](https://dhq.digitalhumanities.org/vol/4/1/000081/000081.html). People could link back to specific parts of a text. This allowed for proto-docuverses, where a text could link directly to the cited portions of sources.

So the question in need of asnwering isn't 'why hasn't the internet augmented social reading and writing', it is: 'why has academic publishing been so severely *underdeveloped*?' The answer, surprise surprise, is monopoly capitalism. Unfortunately for the monopoly publishers of academic knowledge, their own dominance is dwarfed by big tech. This inter-capitalist crisis of knowledge production is scary. Knowledge workers should support copyleft software that supports personal data sovereignty. 

## Contact

[GitHub issues](https://github.com/toldandretold/hyperlit/issues) or [@toldandretold](https://github.com/toldandretold)

Leave a hyperlight in [my hypertext library](https://hyperlit.io/u/toldandretold)



## Notes
[^1]: two-way hyperlinks was a core idea of Ted Nelson's ideas for a Docuverse. Linking directly to the cited text was a feature of the original hypertext editors. See: Belinda Barnet, ["Crafting the User-Centered Document Interface: The Hypertext Editing System (HES) and the File Retrieval and Editing System (FRESS)"](https://dhq.digitalhumanities.org/vol/4/1/000081/000081.html)

[^2]: Knowledge is freely given according to ones abilities, and freely enjoyed according to ones needs.

