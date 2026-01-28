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
-- Name: auth_get_user_after_verify(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_get_user_after_verify(p_id bigint, p_password_hash text) RETURNS TABLE(id bigint, name character varying, email character varying, email_verified_at timestamp without time zone, password character varying, remember_token character varying, user_token uuid, created_at timestamp without time zone, updated_at timestamp without time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at
    FROM users
    WHERE id = p_id
    AND password = p_password_hash
    LIMIT 1
$$;


--
-- Name: auth_lookup_user(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_lookup_user(p_email text) RETURNS TABLE(id bigint, password character varying, remember_token character varying)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, password, remember_token
                FROM users
                WHERE email = p_email
                LIMIT 1
            $$;


--
-- Name: auth_lookup_user_by_id(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_lookup_user_by_id(p_id bigint) RETURNS TABLE(id bigint, name character varying, password character varying, remember_token character varying, created_at timestamp without time zone, updated_at timestamp without time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, name, password, remember_token, created_at, updated_at
                FROM users
                WHERE id = p_id
                LIMIT 1
            $$;


--
-- Name: check_book_visibility(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_book_visibility(p_book_id text) RETURNS TABLE(book_exists boolean, visibility character varying, creator character varying, creator_token uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT
                    true as book_exists,
                    library.visibility,
                    library.creator,
                    library.creator_token
                FROM library
                WHERE library.book = p_book_id
                LIMIT 1
            $$;


--
-- Name: lookup_user_by_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lookup_user_by_name(p_name text) RETURNS TABLE(id bigint, name character varying, created_at timestamp without time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, name, created_at
                FROM users
                WHERE name = p_name
                LIMIT 1
            $$;


--
-- Name: transfer_anonymous_hypercites(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_anonymous_hypercites(p_token text, p_username text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Security check: caller must have the token they're trying to transfer
                session_token := current_setting('app.current_token', true);

                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE hypercites
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            $$;


--
-- Name: transfer_anonymous_hyperlights(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_anonymous_hyperlights(p_token text, p_username text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Security check: caller must have the token they're trying to transfer
                session_token := current_setting('app.current_token', true);

                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE hyperlights
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            $$;


--
-- Name: transfer_anonymous_library(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_anonymous_library(p_token text, p_username text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Get the caller's session token
                session_token := current_setting('app.current_token', true);

                -- Security check: caller must have the token they're trying to transfer
                -- This prevents stolen tokens from being used
                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE library
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer to logged-in user
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            $$;


--
-- Name: update_annotations_timestamp(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_annotations_timestamp(p_book text, p_timestamp bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                book_visibility text;
                updated_count int;
            BEGIN
                -- Check if book exists and is public (or owned by current user)
                SELECT visibility INTO book_visibility
                FROM library
                WHERE book = p_book;

                IF book_visibility IS NULL THEN
                    RETURN false;
                END IF;

                -- Allow update if book is public OR user is the owner
                IF book_visibility = 'public'
                   OR EXISTS (
                       SELECT 1 FROM library
                       WHERE book = p_book
                       AND (
                           (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                           OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                       )
                   )
                THEN
                    UPDATE library
                    SET annotations_updated_at = p_timestamp
                    WHERE book = p_book;

                    GET DIAGNOSTICS updated_count = ROW_COUNT;
                    RETURN updated_count > 0;
                END IF;

                RETURN false;
            END;
            $$;


--
-- Name: validate_anonymous_token(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_anonymous_token(p_token text, p_expiry_days integer DEFAULT 90) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    BEGIN
        RETURN EXISTS (
            SELECT 1 FROM anonymous_sessions
            WHERE token = p_token
              AND created_at > (NOW() - (p_expiry_days || ' days')::interval)
        );
    END;
    $$;


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
    user_agent text,
    ip_change_count integer DEFAULT 0 NOT NULL,
    last_ip_change_at timestamp(0) without time zone
);

ALTER TABLE ONLY public.anonymous_sessions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.bibliography FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.footnotes FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.hypercites FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.hyperlights FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.library FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.nodes FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.sessions FORCE ROW LEVEL SECURITY;


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
    two_factor_confirmed_at timestamp(0) without time zone,
    user_token uuid NOT NULL
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


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
-- Name: nodes nodes_book_startline_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_book_startline_unique UNIQUE (book, "startLine") DEFERRABLE INITIALLY DEFERRED;


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
-- Name: users users_user_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_user_token_unique UNIQUE (user_token);


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
-- Name: users_user_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_user_token_idx ON public.users USING btree (user_token);


--
-- Name: anonymous_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.anonymous_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: anonymous_sessions anonymous_sessions_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY anonymous_sessions_insert_policy ON public.anonymous_sessions FOR INSERT WITH CHECK (true);


--
-- Name: anonymous_sessions anonymous_sessions_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY anonymous_sessions_select_policy ON public.anonymous_sessions FOR SELECT USING ((token = current_setting('app.current_token'::text, true)));


--
-- Name: anonymous_sessions anonymous_sessions_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY anonymous_sessions_update_policy ON public.anonymous_sessions FOR UPDATE USING ((token = current_setting('app.current_token'::text, true)));


--
-- Name: bibliography; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bibliography ENABLE ROW LEVEL SECURITY;

--
-- Name: bibliography bibliography_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bibliography_delete_policy ON public.bibliography FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (bibliography.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: bibliography bibliography_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bibliography_insert_policy ON public.bibliography FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (bibliography.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: bibliography bibliography_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bibliography_select_policy ON public.bibliography FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (bibliography.book)::text) AND (((library.visibility)::text = 'public'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: bibliography bibliography_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bibliography_update_policy ON public.bibliography FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (bibliography.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: footnotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.footnotes ENABLE ROW LEVEL SECURITY;

--
-- Name: footnotes footnotes_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY footnotes_delete_policy ON public.footnotes FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (footnotes.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: footnotes footnotes_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY footnotes_insert_policy ON public.footnotes FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (footnotes.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: footnotes footnotes_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY footnotes_select_policy ON public.footnotes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (footnotes.book)::text) AND (((library.visibility)::text = 'public'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: footnotes footnotes_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY footnotes_update_policy ON public.footnotes FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (footnotes.book)::text) AND ((EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: hypercites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hypercites ENABLE ROW LEVEL SECURITY;

--
-- Name: hypercites hypercites_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hypercites_delete_policy ON public.hypercites FOR DELETE USING (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hypercites.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hypercites hypercites_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hypercites_insert_policy ON public.hypercites FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hypercites.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hypercites hypercites_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hypercites_select_policy ON public.hypercites FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (hypercites.book)::text) AND ((library.visibility)::text = 'public'::text)))) OR (EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hypercites.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hypercites hypercites_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hypercites_update_policy ON public.hypercites FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hypercites.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hyperlights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hyperlights ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperlights hyperlights_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hyperlights_delete_policy ON public.hyperlights FOR DELETE USING (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hyperlights.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hyperlights hyperlights_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hyperlights_insert_policy ON public.hyperlights FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hyperlights.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hyperlights hyperlights_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (hyperlights.book)::text) AND ((library.visibility)::text = 'public'::text)))) OR (EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hyperlights.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: hyperlights hyperlights_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hyperlights_update_policy ON public.hyperlights FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (hyperlights.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: library; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.library ENABLE ROW LEVEL SECURITY;

--
-- Name: library library_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY library_delete_policy ON public.library FOR DELETE USING (((EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) AND (current_setting('app.current_user'::text, true) IS NOT NULL) AND (current_setting('app.current_user'::text, true) <> ''::text)));


--
-- Name: library library_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY library_insert_policy ON public.library FOR INSERT WITH CHECK ((((raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: library library_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY library_select_policy ON public.library FOR SELECT USING ((((visibility)::text = 'public'::text) OR ((raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: library library_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY library_update_policy ON public.library FOR UPDATE USING ((((raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
   FROM public.users
  WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((creator IS NULL) AND (creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: nodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;

--
-- Name: nodes nodes_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nodes_delete_policy ON public.nodes FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (nodes.book)::text) AND (((library.raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: nodes nodes_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nodes_insert_policy ON public.nodes FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (nodes.book)::text) AND (((library.raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: nodes nodes_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nodes_select_policy ON public.nodes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (nodes.book)::text) AND (((library.visibility)::text = 'public'::text) OR ((library.raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: nodes nodes_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nodes_update_policy ON public.nodes FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.library
  WHERE (((library.book)::text = (nodes.book)::text) AND (((library.raw_json ->> 'type'::text) = 'user_home'::text) OR (EXISTS ( SELECT 1
           FROM public.users
          WHERE (((users.name)::text = (library.creator)::text) AND ((users.user_token)::text = current_setting('app.current_token'::text, true))))) OR ((library.creator IS NULL) AND (library.creator_token IS NOT NULL) AND ((library.creator_token)::text = current_setting('app.current_token'::text, true))))))));


--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions sessions_all_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sessions_all_policy ON public.sessions USING (true) WITH CHECK (true);


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_delete_policy ON public.users FOR DELETE USING (((name)::text = current_setting('app.current_user'::text, true)));


--
-- Name: users users_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_insert_policy ON public.users FOR INSERT WITH CHECK (true);


--
-- Name: users users_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_select_policy ON public.users FOR SELECT USING ((((name)::text = current_setting('app.current_user'::text, true)) AND ((user_token IS NULL) OR ((user_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: users users_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_update_policy ON public.users FOR UPDATE USING ((((name)::text = current_setting('app.current_user'::text, true)) AND ((user_token IS NULL) OR ((user_token)::text = current_setting('app.current_token'::text, true)))));


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
28	2025_12_17_035349_add_ip_tracking_to_anonymous_sessions	4
29	2025_12_18_000001_create_rls_database_roles	5
30	2025_12_18_000002_enable_rls_policies	5
31	2025_12_17_231317_add_annotations_timestamp_update_function	6
32	2025_12_17_233354_add_transfer_anonymous_content_function	7
33	2025_12_17_234218_fix_transfer_functions_uuid_cast	8
34	2025_12_17_234450_add_validate_anonymous_token_function	9
35	2025_12_18_120000_add_check_book_visibility_function	10
36	2025_12_18_130000_add_user_token_to_users	11
37	2025_12_18_140000_backfill_creator_token_for_users	11
38	2025_12_18_150000_add_auth_lookup_by_id_function	12
39	2025_12_18_160000_update_rls_policies_require_token	13
40	2025_12_18_170000_refactor_rls_token_in_users_only	14
41	2025_12_19_000001_secure_auth_functions	15
42	2025_12_19_010000_secure_transfer_functions	15
43	2026_01_26_114946_make_nodes_startline_constraint_deferrable	16
\.


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 43, true);


--
-- PostgreSQL database dump complete
--

