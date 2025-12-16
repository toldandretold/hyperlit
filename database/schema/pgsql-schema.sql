--
-- PostgreSQL database dump
--

-- Dumped from database version 14.18 (Homebrew)
-- Dumped by pg_dump version 14.18 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: anonymous_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anonymous_sessions (
    id bigint NOT NULL,
    token text NOT NULL,
    created_at timestamp(0) without time zone NOT NULL,
    last_used_at timestamp(0) without time zone NOT NULL,
    ip_address inet,
    user_agent text
);


--
-- Name: anonymous_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anonymous_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anonymous_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anonymous_sessions_id_seq OWNED BY public.anonymous_sessions.id;


--
-- Name: bibliography; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bibliography (
    book character varying(255) NOT NULL,
    "referenceId" character varying(255) NOT NULL,
    content text NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);


--
-- Name: cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache (
    key character varying(255) NOT NULL,
    value text NOT NULL,
    expiration integer NOT NULL
);


--
-- Name: cache_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache_locks (
    key character varying(255) NOT NULL,
    owner character varying(255) NOT NULL,
    expiration integer NOT NULL
);


--
-- Name: failed_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failed_jobs (
    id bigint NOT NULL,
    uuid character varying(255) NOT NULL,
    connection text NOT NULL,
    queue text NOT NULL,
    payload text NOT NULL,
    exception text NOT NULL,
    failed_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.failed_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.failed_jobs_id_seq OWNED BY public.failed_jobs.id;


--
-- Name: footnotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.footnotes (
    book character varying(255) NOT NULL,
    "footnoteId" character varying(255) NOT NULL,
    content text NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);


--
-- Name: hypercites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hypercites (
    id bigint NOT NULL,
    book character varying(255) NOT NULL,
    "hyperciteId" character varying(255) NOT NULL,
    "citedIN" jsonb,
    "hypercitedHTML" text,
    "hypercitedText" text,
    "relationshipStatus" character varying(255),
    raw_json jsonb NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    creator character varying(255),
    creator_token uuid,
    time_since bigint,
    node_id jsonb,
    "charData" jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: hypercites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hypercites_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hypercites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hypercites_id_seq OWNED BY public.hypercites.id;


--
-- Name: hyperlights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hyperlights (
    id bigint NOT NULL,
    book character varying(255) NOT NULL,
    hyperlight_id character varying(255) NOT NULL,
    annotation character varying(1000),
    "highlightedHTML" text,
    "highlightedText" text,
    "startLine" character varying(255),
    raw_json jsonb NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    creator character varying(255),
    creator_token uuid,
    time_since bigint,
    hidden boolean DEFAULT false NOT NULL,
    node_id jsonb,
    "charData" jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: hyperlights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hyperlights_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hyperlights_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hyperlights_id_seq OWNED BY public.hyperlights.id;


--
-- Name: job_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_batches (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    total_jobs integer NOT NULL,
    pending_jobs integer NOT NULL,
    failed_jobs integer NOT NULL,
    failed_job_ids text NOT NULL,
    options text,
    cancelled_at integer,
    created_at integer NOT NULL,
    finished_at integer
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    queue character varying(255) NOT NULL,
    payload text NOT NULL,
    attempts smallint NOT NULL,
    reserved_at integer,
    available_at integer NOT NULL,
    created_at integer NOT NULL
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;


--
-- Name: library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library (
    book character varying(255) NOT NULL,
    author character varying(255),
    bibtex text,
    "fileName" character varying(255),
    "fileType" character varying(255),
    journal character varying(255),
    note text,
    pages character varying(255),
    publisher character varying(255),
    school character varying(255),
    "timestamp" bigint,
    title character varying(255),
    type character varying(255),
    url text,
    year character varying(255),
    raw_json jsonb NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    recent integer,
    total_views integer,
    total_citations integer,
    total_highlights integer,
    creator character varying(255),
    creator_token uuid,
    visibility character varying(20) DEFAULT 'public'::character varying NOT NULL,
    listed boolean DEFAULT true NOT NULL,
    license character varying(100) DEFAULT 'CC-BY-SA-4.0-NO-AI'::character varying NOT NULL,
    custom_license_text text,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, (COALESCE(author, ''::character varying))::text), 'B'::"char"))) STORED,
    annotations_updated_at bigint DEFAULT '0'::bigint NOT NULL
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    migration character varying(255) NOT NULL,
    batch integer NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodes (
    id bigint NOT NULL,
    raw_json jsonb NOT NULL,
    book character varying(255) NOT NULL,
    chunk_id double precision NOT NULL,
    "startLine" double precision NOT NULL,
    footnotes jsonb,
    content text,
    "plainText" text,
    type character varying(255),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    node_id character varying(255),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE("plainText", content, ''::text))) STORED,
    search_vector_simple tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE("plainText", content, ''::text))) STORED
);


--
-- Name: node_chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_chunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_chunks_id_seq OWNED BY public.nodes.id;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    email character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    created_at timestamp(0) without time zone
);


--
-- Name: personal_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_access_tokens (
    id bigint NOT NULL,
    tokenable_type character varying(255) NOT NULL,
    tokenable_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    token character varying(64) NOT NULL,
    abilities text,
    last_used_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);


--
-- Name: personal_access_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.personal_access_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: personal_access_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.personal_access_tokens_id_seq OWNED BY public.personal_access_tokens.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id character varying(255) NOT NULL,
    user_id bigint,
    ip_address character varying(45),
    user_agent text,
    payload text NOT NULL,
    last_activity integer NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    email_verified_at timestamp(0) without time zone,
    password character varying(255) NOT NULL,
    remember_token character varying(100),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    two_factor_secret text,
    two_factor_recovery_codes text,
    two_factor_confirmed_at timestamp(0) without time zone
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: anonymous_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions ALTER COLUMN id SET DEFAULT nextval('public.anonymous_sessions_id_seq'::regclass);


--
-- Name: failed_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs ALTER COLUMN id SET DEFAULT nextval('public.failed_jobs_id_seq'::regclass);


--
-- Name: hypercites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypercites ALTER COLUMN id SET DEFAULT nextval('public.hypercites_id_seq'::regclass);


--
-- Name: hyperlights id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hyperlights ALTER COLUMN id SET DEFAULT nextval('public.hyperlights_id_seq'::regclass);


--
-- Name: jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes ALTER COLUMN id SET DEFAULT nextval('public.node_chunks_id_seq'::regclass);


--
-- Name: personal_access_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.personal_access_tokens_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: anonymous_sessions anonymous_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_pkey PRIMARY KEY (id);


--
-- Name: anonymous_sessions anonymous_sessions_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_token_unique UNIQUE (token);


--
-- Name: cache_locks cache_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache_locks
    ADD CONSTRAINT cache_locks_pkey PRIMARY KEY (key);


--
-- Name: cache cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache
    ADD CONSTRAINT cache_pkey PRIMARY KEY (key);


--
-- Name: failed_jobs failed_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_pkey PRIMARY KEY (id);


--
-- Name: failed_jobs failed_jobs_uuid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_uuid_unique UNIQUE (uuid);


--
-- Name: footnotes footnotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.footnotes
    ADD CONSTRAINT footnotes_pkey PRIMARY KEY (book, "footnoteId");


--
-- Name: hypercites hypercites_book_hyperciteid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypercites
    ADD CONSTRAINT hypercites_book_hyperciteid_unique UNIQUE (book, "hyperciteId");


--
-- Name: hypercites hypercites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypercites
    ADD CONSTRAINT hypercites_pkey PRIMARY KEY (id);


--
-- Name: hyperlights hyperlights_book_hyperlight_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hyperlights
    ADD CONSTRAINT hyperlights_book_hyperlight_id_unique UNIQUE (book, hyperlight_id);


--
-- Name: hyperlights hyperlights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hyperlights
    ADD CONSTRAINT hyperlights_pkey PRIMARY KEY (id);


--
-- Name: job_batches job_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_batches
    ADD CONSTRAINT job_batches_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: library library_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library
    ADD CONSTRAINT library_pkey PRIMARY KEY (book);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: nodes node_chunks_node_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT node_chunks_node_id_unique UNIQUE (node_id);


--
-- Name: nodes node_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT node_chunks_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (email);


--
-- Name: personal_access_tokens personal_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: personal_access_tokens personal_access_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_token_unique UNIQUE (token);


--
-- Name: bibliography references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bibliography
    ADD CONSTRAINT references_pkey PRIMARY KEY (book, "referenceId");


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: anonymous_sessions_last_used_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_last_used_at_index ON public.anonymous_sessions USING btree (last_used_at);


--
-- Name: anonymous_sessions_token_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_token_created_at_index ON public.anonymous_sessions USING btree (token, created_at);


--
-- Name: hypercites_book_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hypercites_book_index ON public.hypercites USING btree (book);


--
-- Name: hypercites_creator_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hypercites_creator_token_index ON public.hypercites USING btree (creator_token);


--
-- Name: hyperlights_book_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hyperlights_book_index ON public.hyperlights USING btree (book);


--
-- Name: idx_hypercites_chardata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hypercites_chardata ON public.hypercites USING gin ("charData");


--
-- Name: idx_hypercites_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hypercites_node_id ON public.hypercites USING gin (node_id);


--
-- Name: idx_hyperlights_chardata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hyperlights_chardata ON public.hyperlights USING gin ("charData");


--
-- Name: idx_hyperlights_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hyperlights_node_id ON public.hyperlights USING gin (node_id);


--
-- Name: jobs_queue_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_queue_index ON public.jobs USING btree (queue);


--
-- Name: library_creator_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_creator_token_index ON public.library USING btree (creator_token);


--
-- Name: library_search_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_search_vector_idx ON public.library USING gin (search_vector);


--
-- Name: node_chunks_node_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_chunks_node_id_index ON public.nodes USING btree (node_id);


--
-- Name: nodes_book_node_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nodes_book_node_id_unique ON public.nodes USING btree (book, node_id) WHERE (node_id IS NOT NULL);


--
-- Name: nodes_book_startline_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nodes_book_startline_unique ON public.nodes USING btree (book, "startLine");


--
-- Name: nodes_search_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_search_vector_idx ON public.nodes USING gin (search_vector);


--
-- Name: nodes_search_vector_simple_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_search_vector_simple_idx ON public.nodes USING gin (search_vector_simple);


--
-- Name: personal_access_tokens_tokenable_type_tokenable_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_tokenable_type_tokenable_id_index ON public.personal_access_tokens USING btree (tokenable_type, tokenable_id);


--
-- Name: sessions_last_activity_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_last_activity_index ON public.sessions USING btree (last_activity);


--
-- Name: sessions_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_index ON public.sessions USING btree (user_id);


--
-- PostgreSQL database dump complete
--

--
-- PostgreSQL database dump
--

-- Dumped from database version 14.18 (Homebrew)
-- Dumped by pg_dump version 14.18 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.migrations (id, migration, batch) FROM stdin;
1	2025_06_25_070106_add_time_since_to_hyperlights_table	1
2	2025_07_03_223443_create_anonymous_sessions_table	1
3	2025_07_03_223759_add_creator_columns_to_hypercites_table	1
4	2025_07_05_065455_change_anonymous_sessions_token_to_text	1
5	2025_07_05_133037_change_anonymous_sessions_token_to_text	1
6	2025_08_08_004016_create_references_table	1
7	2025_08_08_004059_update_footnotes_table_for_individual_records	1
8	2025_08_08_011834_rename_references_table_to_bibliography	1
9	2025_09_04_090941_add_private_column_to_library_table	1
10	2025_09_10_121143_add_time_since_to_hypercites_table	1
11	2025_09_14_121243_add_hidden_field_to_pg_hyperlights_table	1
12	2025_09_14_230729_add_node_uuid_to_node_chunks	1
13	2025_10_26_105401_replace_private_with_visibility_and_listed_in_library_table	2
14	2025_11_14_095455_drop_citation_id_from_library_table	2
15	2025_11_15_081142_rename_node_chunks_to_nodes	2
16	2025_11_15_101542_add_license_to_library_table	3
17	2025_11_21_101822_add_node_id_to_highlights_and_hypercites	3
18	2025_11_21_103337_add_chardata_to_highlights_and_hypercites	3
19	2025_11_23_022848_drop_hyperlights_hypercites_from_nodes_table	3
20	2025_11_23_023654_drop_start_char_end_char_from_hyperlights_hypercites_tables	3
21	2025_11_24_221106_change_url_to_text_in_library_table	3
22	2025_12_12_134055_add_composite_indexes_to_nodes_table	3
23	2025_12_15_000001_add_full_text_search_to_library_table	3
24	2025_12_15_000002_add_full_text_search_to_nodes_table	3
25	2025_12_15_092358_update_library_search_vector_simple_title_author	3
26	2025_12_15_094658_add_simple_search_vector_to_nodes_table	3
27	2025_12_17_100000_add_annotations_updated_at_to_library_table	3
\.


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 27, true);


--
-- PostgreSQL database dump complete
--

