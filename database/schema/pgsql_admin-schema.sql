--
-- PostgreSQL database dump
--

\restrict oS2KCQOTyZjy0vPTqq5DBChecXh23c05FDP28ohzdn9fvoNjeoyZ5Kx0nvr9iwL

-- Dumped from database version 14.22 (Homebrew)
-- Dumped by pg_dump version 14.22 (Homebrew)

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
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: auth_change_user_email(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_change_user_email(p_id bigint, p_new_email text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                rows_affected int;
            BEGIN
                UPDATE users
                SET email = p_new_email, email_verified_at = NULL, updated_at = now()
                WHERE id = p_id;
                GET DIAGNOSTICS rows_affected = ROW_COUNT;
                RETURN rows_affected > 0;
            END;
            $$;


--
-- Name: auth_create_password_reset_token(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_create_password_reset_token(p_email text, p_token_hash text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            BEGIN
                DELETE FROM password_reset_tokens WHERE email = p_email;
                INSERT INTO password_reset_tokens (email, token, created_at)
                VALUES (p_email, p_token_hash, now());
                RETURN true;
            END;
            $$;


--
-- Name: auth_execute_password_reset(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_execute_password_reset(p_email text, p_plain_token text, p_new_password text, p_new_remember_token text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                v_stored_hash text;
                v_created_at  timestamptz;
            BEGIN
                -- Look up stored token
                SELECT token, created_at INTO v_stored_hash, v_created_at
                FROM password_reset_tokens
                WHERE email = p_email
                LIMIT 1;

                -- No token found
                IF v_stored_hash IS NULL THEN
                    RETURN false;
                END IF;

                -- Check 60-minute expiry
                IF v_created_at < (now() - interval '60 minutes') THEN
                    DELETE FROM password_reset_tokens WHERE email = p_email;
                    RETURN false;
                END IF;

                -- Verify token: SHA-256 hash of plain token must match stored hash
                IF encode(sha256(p_plain_token::bytea), 'hex') <> v_stored_hash THEN
                    RETURN false;
                END IF;

                -- Update password
                UPDATE users
                SET password = p_new_password,
                    remember_token = p_new_remember_token,
                    updated_at = now()
                WHERE email = p_email;

                -- Delete used token
                DELETE FROM password_reset_tokens WHERE email = p_email;

                RETURN true;
            END;
            $$;


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
-- Name: auth_lookup_user_by_email(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_lookup_user_by_email(p_email text) RETURNS TABLE(id bigint, email character varying)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, email FROM users WHERE email = p_email LIMIT 1
            $$;


--
-- Name: auth_lookup_user_by_id(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_lookup_user_by_id(p_id bigint) RETURNS TABLE(id bigint, name character varying, email character varying, email_verified_at timestamp without time zone, password character varying, remember_token character varying, user_token uuid, created_at timestamp without time zone, updated_at timestamp without time zone, status character varying, credits numeric, debits numeric, preferences jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at, status, credits, debits, preferences
                FROM users
                WHERE id = p_id
                LIMIT 1
            $$;


--
-- Name: auth_verify_user_email(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_verify_user_email(p_id bigint, p_email text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
            DECLARE
                rows_affected int;
            BEGIN
                UPDATE users
                SET email_verified_at = now(), updated_at = now()
                WHERE id = p_id AND email = p_email AND email_verified_at IS NULL;
                GET DIAGNOSTICS rows_affected = ROW_COUNT;
                RETURN rows_affected > 0;
            END;
            $$;


--
-- Name: check_book_visibility(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_book_visibility(p_book_id text) RETURNS TABLE(book_exists boolean, visibility character varying, creator character varying, is_owner boolean)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT
                    true,
                    library.visibility,
                    library.creator,
                    (
                        (library.creator IS NOT NULL
                         AND library.creator = current_setting('app.current_user', true))
                        OR
                        (library.creator_token IS NOT NULL
                         AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                FROM library
                WHERE library.book = p_book_id
                LIMIT 1
            $$;


--
-- Name: check_slug_book_collision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_slug_book_collision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        -- When setting/changing a slug, ensure it doesn't match any existing book ID
        IF NEW.slug IS NOT NULL THEN
            IF EXISTS (SELECT 1 FROM library WHERE book = NEW.slug) THEN
                RAISE EXCEPTION 'slug "%" collides with an existing book ID', NEW.slug;
            END IF;
        END IF;
        -- When inserting a new book, ensure the book ID doesn't match any existing slug
        IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.book IS DISTINCT FROM OLD.book) THEN
            IF EXISTS (SELECT 1 FROM library WHERE slug = NEW.book AND book != NEW.book) THEN
                RAISE EXCEPTION 'book ID "%" collides with an existing slug', NEW.book;
            END IF;
        END IF;
        RETURN NEW;
    END;
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
-- Name: session_read(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.session_read(p_id text) RETURNS TABLE(id character varying, user_id bigint, ip_address character varying, user_agent text, payload text, last_activity integer)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
                SELECT id, user_id, ip_address, user_agent, payload, last_activity
                FROM sessions WHERE id = p_id LIMIT 1
            $$;


--
-- Name: sync_footnote_sub_book_visibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_footnote_sub_book_visibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
    BEGIN
        IF NEW.visibility IS DISTINCT FROM OLD.visibility
           AND NEW.type IS DISTINCT FROM 'sub_book' THEN
            UPDATE library
            SET    visibility = NEW.visibility
            WHERE  book LIKE NEW.book || '/%'
              AND  type = 'sub_book'
              AND  substring(book from '/([^/]+)$') LIKE '%Fn%';
        END IF;
        RETURN NEW;
    END;
    $_$;


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


--
-- Name: versioning(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.versioning() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
            DECLARE
                sys_period text;
                history_table text;
                manipulate jsonb;
                mitigate_update_conflicts text;
                ignore_unchanged_values bool;
                include_current_version_in_history bool;
                commonColumns text[];
                time_stamp_to_use timestamptz;
                range_lower timestamptz;
                existing_range tstzrange;
                holder record;
                holder2 record;
                pg_version integer;
                newVersion record;
                oldVersion record;
                user_defined_system_time text;
            BEGIN
                -- set custom system time if exists
                BEGIN
                    SELECT current_setting('user_defined.system_time') INTO user_defined_system_time;
                    IF NOT FOUND OR (user_defined_system_time <> '') IS NOT TRUE THEN
                        time_stamp_to_use := CURRENT_TIMESTAMP;
                    ELSE
                        SELECT TO_TIMESTAMP(
                            user_defined_system_time,
                            'YYYY-MM-DD HH24:MI:SS.MS.US'
                        ) INTO time_stamp_to_use;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    time_stamp_to_use := CURRENT_TIMESTAMP;
                END;

                IF TG_WHEN != 'BEFORE' OR TG_LEVEL != 'ROW' THEN
                    RAISE TRIGGER_PROTOCOL_VIOLATED USING
                        MESSAGE = 'function "versioning" must be fired BEFORE ROW';
                END IF;

                IF TG_OP != 'INSERT' AND TG_OP != 'UPDATE' AND TG_OP != 'DELETE' THEN
                    RAISE TRIGGER_PROTOCOL_VIOLATED USING
                        MESSAGE = 'function "versioning" must be fired for INSERT or UPDATE or DELETE';
                END IF;

                IF TG_NARGS < 3 THEN
                    RAISE INVALID_PARAMETER_VALUE USING
                        MESSAGE = 'wrong number of parameters for function "versioning"',
                        HINT = 'expected at least 3 parameters but got ' || TG_NARGS;
                END IF;

                sys_period := TG_ARGV[0];
                history_table := TG_ARGV[1];
                mitigate_update_conflicts := TG_ARGV[2];
                ignore_unchanged_values := COALESCE(TG_ARGV[3],'false');
                include_current_version_in_history := COALESCE(TG_ARGV[4],'false');

                IF ignore_unchanged_values AND TG_OP = 'UPDATE' THEN
                    IF NEW IS NOT DISTINCT FROM OLD THEN
                        RETURN OLD;
                    END IF;
                END IF;

                -- check if sys_period exists on original table
                SELECT atttypid, attndims INTO holder FROM pg_attribute WHERE attrelid = TG_RELID AND attname = sys_period AND NOT attisdropped;
                IF NOT FOUND THEN
                    RAISE 'column "%" of relation "%" does not exist', sys_period, TG_TABLE_NAME USING
                        ERRCODE = 'undefined_column';
                END IF;
                IF holder.atttypid != to_regtype('tstzrange') THEN
                    IF holder.attndims > 0 THEN
                        RAISE 'system period column "%" of relation "%" is not a range but an array', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'datatype_mismatch';
                    END IF;

                    SELECT rngsubtype INTO holder2 FROM pg_range WHERE rngtypid = holder.atttypid;
                    IF FOUND THEN
                        RAISE 'system period column "%" of relation "%" is not a range of timestamp with timezone but of type %', sys_period, TG_TABLE_NAME, format_type(holder2.rngsubtype, null) USING
                            ERRCODE = 'datatype_mismatch';
                    END IF;

                    RAISE 'system period column "%" of relation "%" is not a range but type %', sys_period, TG_TABLE_NAME, format_type(holder.atttypid, null) USING
                        ERRCODE = 'datatype_mismatch';
                END IF;

                IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
                    -- Ignore rows already modified in the current transaction
                    IF OLD.xmin::text = (txid_current() % (2^32)::bigint)::text THEN
                        IF TG_OP = 'DELETE' THEN
                            RETURN OLD;
                        END IF;
                        RETURN NEW;
                    END IF;

                    SELECT current_setting('server_version_num')::integer INTO pg_version;

                    -- check if history table exists
                    IF pg_version < 90600 THEN
                        IF to_regclass(history_table::cstring) IS NULL THEN
                            RAISE 'relation "%" does not exist', history_table;
                        END IF;
                    ELSE
                        IF to_regclass(history_table) IS NULL THEN
                            RAISE 'relation "%" does not exist', history_table;
                        END IF;
                    END IF;

                    -- check if history table has sys_period
                    IF NOT EXISTS(SELECT * FROM pg_attribute WHERE attrelid = history_table::regclass AND attname = sys_period AND NOT attisdropped) THEN
                        RAISE 'history relation "%" does not contain system period column "%"', history_table, sys_period USING
                            HINT = 'history relation must contain system period column with the same name and data type as the versioned one';
                    END IF;

                    EXECUTE format('SELECT $1.%I', sys_period) USING OLD INTO existing_range;

                    IF existing_range IS NULL THEN
                        RAISE 'system period column "%" of relation "%" must not be null', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'null_value_not_allowed';
                    END IF;

                    IF isempty(existing_range) OR NOT upper_inf(existing_range) THEN
                        RAISE 'system period column "%" of relation "%" contains invalid value', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'data_exception',
                            DETAIL = 'valid ranges must be non-empty and unbounded on the high side';
                    END IF;

                    range_lower := lower(existing_range);

                    IF mitigate_update_conflicts = 'true' THEN
                        -- mitigate update conflicts
                        IF range_lower >= time_stamp_to_use THEN
                            time_stamp_to_use := range_lower + interval '1 microseconds';
                        END IF;
                    END IF;

                    WITH history AS
                        (SELECT attname, atttypid
                        FROM pg_attribute
                        WHERE attrelid = history_table::regclass
                        AND attnum > 0
                        AND NOT attisdropped),
                    main AS
                        (SELECT attname, atttypid
                        FROM pg_attribute
                        WHERE attrelid = TG_RELID
                        AND attnum > 0
                        AND NOT attisdropped)
                    SELECT
                        history.attname AS history_name,
                        main.attname AS main_name,
                        history.atttypid AS history_type,
                        main.atttypid AS main_type
                    INTO holder
                    FROM history
                    INNER JOIN main
                        ON history.attname = main.attname
                    WHERE history.atttypid != main.atttypid;

                    IF FOUND THEN
                        RAISE 'column "%" of relation "%" is of type % but column "%" of history relation "%" is of type %',
                            holder.main_name, TG_TABLE_NAME, format_type(holder.main_type, null), holder.history_name, history_table, format_type(holder.history_type, null)
                        USING ERRCODE = 'datatype_mismatch';
                    END IF;

                    WITH history AS
                        (SELECT attname
                        FROM pg_attribute
                        WHERE attrelid = history_table::regclass
                        AND attnum > 0
                        AND NOT attisdropped),
                    main AS
                        (SELECT attname
                        FROM pg_attribute
                        WHERE attrelid = TG_RELID
                        AND attnum > 0
                        AND NOT attisdropped)
                    SELECT array_agg(quote_ident(history.attname)) INTO commonColumns
                    FROM history
                    INNER JOIN main
                        ON history.attname = main.attname
                        AND history.attname != sys_period;

                    -- Insert old version into history with closed time range
                    EXECUTE ('INSERT INTO ' ||
                        history_table ||
                        '(' ||
                        array_to_string(commonColumns , ',') ||
                        ',' ||
                        quote_ident(sys_period) ||
                        ') VALUES ($1.' ||
                        array_to_string(commonColumns, ',$1.') ||
                        ',tstzrange($2, $3, ''[)''))')
                    USING OLD, range_lower, time_stamp_to_use;
                END IF;

                IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
                    manipulate := jsonb_set('{}'::jsonb, ('{' || sys_period || '}')::text[], to_jsonb(tstzrange(time_stamp_to_use, null, '[)')));
                    RETURN jsonb_populate_record(NEW, manipulate);
                END IF;

                RETURN OLD;
            END;
            $_$;


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
    updated_at timestamp(0) without time zone,
    source_id character varying(255),
    foundation_source character varying(255),
    llm_metadata jsonb,
    match_method character varying(50),
    match_score double precision,
    match_diagnostics json
);

ALTER TABLE ONLY public.bibliography FORCE ROW LEVEL SECURITY;


--
-- Name: billing_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_ledger (
    id uuid NOT NULL,
    user_id bigint NOT NULL,
    type character varying(255) NOT NULL,
    amount numeric(10,4) NOT NULL,
    description character varying(255) NOT NULL,
    category character varying(255) NOT NULL,
    line_items jsonb,
    metadata jsonb,
    balance_after numeric(10,4) NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
-- Name: citation_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.citation_pipelines (
    id uuid NOT NULL,
    book character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    current_step character varying(30),
    step_detail text,
    error text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    step_timings jsonb,
    user_id bigint
);


--
-- Name: citation_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.citation_scans (
    id uuid NOT NULL,
    book character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    total_entries integer DEFAULT 0 NOT NULL,
    already_linked integer DEFAULT 0 NOT NULL,
    newly_resolved integer DEFAULT 0 NOT NULL,
    failed_to_resolve integer DEFAULT 0 NOT NULL,
    enriched_existing integer DEFAULT 0 NOT NULL,
    results jsonb,
    error text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
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
    updated_at timestamp(0) without time zone,
    preview_nodes jsonb,
    sub_book_id character varying(255),
    is_citation boolean DEFAULT false NOT NULL,
    source_id character varying(255),
    foundation_source character varying(255),
    llm_metadata jsonb,
    match_method character varying(50),
    match_score double precision,
    match_diagnostics json
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
    "charData" jsonb DEFAULT '{}'::jsonb NOT NULL,
    access_granted jsonb
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
    "charData" jsonb DEFAULT '{}'::jsonb NOT NULL,
    preview_nodes jsonb,
    sub_book_id character varying(255),
    access_granted jsonb
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
    annotations_updated_at bigint DEFAULT '0'::bigint NOT NULL,
    volume character varying(255),
    issue character varying(255),
    booktitle character varying(255),
    chapter character varying(255),
    editor character varying(255),
    has_nodes boolean DEFAULT true NOT NULL,
    openalex_id character varying(30),
    doi character varying(255),
    is_oa boolean,
    oa_status character varying(20),
    oa_url text,
    pdf_url text,
    work_license character varying(100),
    cited_by_count integer,
    language character varying(10),
    search_vector tsvector GENERATED ALWAYS AS ((((((setweight(to_tsvector('simple'::regconfig, (COALESCE(author, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying))::text), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(booktitle, ''::character varying))::text), 'C'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(chapter, ''::character varying))::text), 'C'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(editor, ''::character varying))::text), 'D'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(year, ''::character varying))::text), 'D'::"char"))) STORED,
    foundation_source character varying(255),
    open_library_key character varying(50),
    abstract text,
    pdf_url_status text,
    access_granted jsonb,
    slug character varying(255),
    gate_defaults jsonb
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
    search_vector_simple tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE("plainText", content, ''::text))) STORED,
    sys_period tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL::timestamp with time zone, '[)'::text) NOT NULL,
    embedding public.vector(768)
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
-- Name: nodes_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodes_history (
    id bigint DEFAULT nextval('public.node_chunks_id_seq'::regclass) NOT NULL,
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
    sys_period tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL::timestamp with time zone, '[)'::text) NOT NULL,
    history_id bigint NOT NULL
);


--
-- Name: nodes_history_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nodes_history_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nodes_history_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nodes_history_history_id_seq OWNED BY public.nodes_history.history_id;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    email character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    created_at timestamp(0) without time zone
);

ALTER TABLE ONLY public.password_reset_tokens FORCE ROW LEVEL SECURITY;


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
-- Name: pinned_books; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pinned_books (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    book character varying NOT NULL,
    creator character varying,
    creator_token uuid,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);

ALTER TABLE ONLY public.pinned_books FORCE ROW LEVEL SECURITY;


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
-- Name: user_reading_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reading_positions (
    id bigint NOT NULL,
    book character varying(255) NOT NULL,
    user_name character varying(255),
    anon_token character varying(255),
    chunk_id integer DEFAULT 0 NOT NULL,
    element_id character varying(255),
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_reading_positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_reading_positions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_reading_positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_reading_positions_id_seq OWNED BY public.user_reading_positions.id;


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
    user_token uuid NOT NULL,
    status character varying(50),
    credits numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    debits numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    preferences json,
    is_admin boolean DEFAULT false NOT NULL
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
-- Name: vibes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vibes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    prompt character varying(500),
    css_overrides jsonb NOT NULL,
    visibility character varying(10) DEFAULT 'private'::character varying NOT NULL,
    creator character varying,
    creator_token uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    pull_count integer DEFAULT 0 NOT NULL,
    source_creator character varying
);

ALTER TABLE ONLY public.vibes FORCE ROW LEVEL SECURITY;


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
-- Name: nodes_history history_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes_history ALTER COLUMN history_id SET DEFAULT nextval('public.nodes_history_history_id_seq'::regclass);


--
-- Name: personal_access_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.personal_access_tokens_id_seq'::regclass);


--
-- Name: user_reading_positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reading_positions ALTER COLUMN id SET DEFAULT nextval('public.user_reading_positions_id_seq'::regclass);


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
-- Name: billing_ledger billing_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_ledger
    ADD CONSTRAINT billing_ledger_pkey PRIMARY KEY (id);


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
-- Name: citation_pipelines citation_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.citation_pipelines
    ADD CONSTRAINT citation_pipelines_pkey PRIMARY KEY (id);


--
-- Name: citation_scans citation_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.citation_scans
    ADD CONSTRAINT citation_scans_pkey PRIMARY KEY (id);


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
-- Name: nodes_history nodes_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes_history
    ADD CONSTRAINT nodes_history_pkey PRIMARY KEY (history_id);


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
-- Name: pinned_books pinned_books_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pinned_books
    ADD CONSTRAINT pinned_books_pkey PRIMARY KEY (id);


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
-- Name: user_reading_positions user_reading_positions_book_anon_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reading_positions
    ADD CONSTRAINT user_reading_positions_book_anon_token_unique UNIQUE (book, anon_token);


--
-- Name: user_reading_positions user_reading_positions_book_user_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reading_positions
    ADD CONSTRAINT user_reading_positions_book_user_name_unique UNIQUE (book, user_name);


--
-- Name: user_reading_positions user_reading_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reading_positions
    ADD CONSTRAINT user_reading_positions_pkey PRIMARY KEY (id);


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
-- Name: vibes vibes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vibes
    ADD CONSTRAINT vibes_pkey PRIMARY KEY (id);


--
-- Name: anonymous_sessions_last_used_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_last_used_at_index ON public.anonymous_sessions USING btree (last_used_at);


--
-- Name: anonymous_sessions_token_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_token_created_at_index ON public.anonymous_sessions USING btree (token, created_at);


--
-- Name: bibliography_foundation_source_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bibliography_foundation_source_index ON public.bibliography USING btree (foundation_source);


--
-- Name: bibliography_source_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bibliography_source_id_index ON public.bibliography USING btree (source_id);


--
-- Name: citation_pipelines_book_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX citation_pipelines_book_index ON public.citation_pipelines USING btree (book);


--
-- Name: citation_scans_book_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX citation_scans_book_index ON public.citation_scans USING btree (book);


--
-- Name: footnotes_sub_book_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX footnotes_sub_book_id_index ON public.footnotes USING btree (sub_book_id);


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
-- Name: hyperlights_sub_book_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hyperlights_sub_book_id_index ON public.hyperlights USING btree (sub_book_id);


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
-- Name: idx_library_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_library_slug ON public.library USING btree (slug) WHERE (slug IS NOT NULL);


--
-- Name: idx_nodes_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_embedding ON public.nodes USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: jobs_queue_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_queue_index ON public.jobs USING btree (queue);


--
-- Name: library_creator_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_creator_token_index ON public.library USING btree (creator_token);


--
-- Name: library_foundation_source_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_foundation_source_index ON public.library USING btree (foundation_source);


--
-- Name: library_open_library_key_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_open_library_key_index ON public.library USING btree (open_library_key);


--
-- Name: library_openalex_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_openalex_id_index ON public.library USING btree (openalex_id);


--
-- Name: library_search_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX library_search_vector_idx ON public.library USING gin (search_vector);


--
-- Name: node_chunks_node_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_chunks_node_id_index ON public.nodes USING btree (node_id);


--
-- Name: nodes_book_chunk_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_book_chunk_id_index ON public.nodes USING btree (book, chunk_id);


--
-- Name: nodes_book_node_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nodes_book_node_id_unique ON public.nodes USING btree (book, node_id) WHERE (node_id IS NOT NULL);


--
-- Name: nodes_history_book_changed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_history_book_changed_at_idx ON public.nodes_history USING btree (book, upper(sys_period) DESC NULLS LAST);


--
-- Name: nodes_history_book_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_history_book_idx ON public.nodes_history USING btree (book);


--
-- Name: nodes_history_book_node_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_history_book_node_id_idx ON public.nodes_history USING btree (book, node_id);


--
-- Name: nodes_history_sys_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_history_sys_period_idx ON public.nodes_history USING gist (sys_period);


--
-- Name: nodes_search_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_search_vector_idx ON public.nodes USING gin (search_vector);


--
-- Name: nodes_search_vector_simple_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_search_vector_simple_idx ON public.nodes USING gin (search_vector_simple);


--
-- Name: nodes_sys_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nodes_sys_period_idx ON public.nodes USING gist (sys_period);


--
-- Name: personal_access_tokens_tokenable_type_tokenable_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_access_tokens_tokenable_type_tokenable_id_index ON public.personal_access_tokens USING btree (tokenable_type, tokenable_id);


--
-- Name: pinned_books_book_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pinned_books_book_idx ON public.pinned_books USING btree (book);


--
-- Name: pinned_books_creator_book_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pinned_books_creator_book_unique ON public.pinned_books USING btree (creator, book);


--
-- Name: pinned_books_creator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pinned_books_creator_idx ON public.pinned_books USING btree (creator);


--
-- Name: pinned_books_creator_token_book_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pinned_books_creator_token_book_unique ON public.pinned_books USING btree (creator_token, book);


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
-- Name: vibes_creator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vibes_creator_idx ON public.vibes USING btree (creator);


--
-- Name: vibes_public_popular_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vibes_public_popular_idx ON public.vibes USING btree (visibility, pull_count DESC, created_at DESC);


--
-- Name: vibes_visibility_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vibes_visibility_created_idx ON public.vibes USING btree (visibility, created_at DESC);


--
-- Name: nodes nodes_versioning_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER nodes_versioning_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.versioning('sys_period', 'nodes_history', 'true');


--
-- Name: library trg_check_slug_book_collision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_check_slug_book_collision BEFORE INSERT OR UPDATE ON public.library FOR EACH ROW EXECUTE FUNCTION public.check_slug_book_collision();


--
-- Name: library trg_sync_footnote_sub_book_visibility; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_footnote_sub_book_visibility AFTER UPDATE OF visibility ON public.library FOR EACH ROW EXECUTE FUNCTION public.sync_footnote_sub_book_visibility();


--
-- Name: billing_ledger 1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_ledger
    ADD CONSTRAINT "1" FOREIGN KEY (user_id) REFERENCES public.users(id);


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
-- Name: password_reset_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: pinned_books; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pinned_books ENABLE ROW LEVEL SECURITY;

--
-- Name: pinned_books pinned_books_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pinned_books_delete_policy ON public.pinned_books FOR DELETE USING (((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true)) AND (current_setting('app.current_user'::text, true) IS NOT NULL) AND (current_setting('app.current_user'::text, true) <> ''::text)));


--
-- Name: pinned_books pinned_books_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pinned_books_insert_policy ON public.pinned_books FOR INSERT WITH CHECK ((((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: pinned_books pinned_books_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pinned_books_select_policy ON public.pinned_books FOR SELECT USING ((((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: pinned_books pinned_books_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pinned_books_update_policy ON public.pinned_books FOR UPDATE USING ((((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


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
-- Name: vibes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vibes ENABLE ROW LEVEL SECURITY;

--
-- Name: vibes vibes_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vibes_delete_policy ON public.vibes FOR DELETE USING (((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true)) AND (current_setting('app.current_user'::text, true) IS NOT NULL) AND (current_setting('app.current_user'::text, true) <> ''::text)));


--
-- Name: vibes vibes_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vibes_insert_policy ON public.vibes FOR INSERT WITH CHECK ((((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: vibes vibes_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vibes_select_policy ON public.vibes FOR SELECT USING ((((visibility)::text = 'public'::text) OR ((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- Name: vibes vibes_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vibes_update_policy ON public.vibes FOR UPDATE USING ((((creator IS NOT NULL) AND ((creator)::text = current_setting('app.current_user'::text, true))) OR ((creator_token IS NOT NULL) AND ((creator_token)::text = current_setting('app.current_token'::text, true)))));


--
-- PostgreSQL database dump complete
--

\unrestrict oS2KCQOTyZjy0vPTqq5DBChecXh23c05FDP28ohzdn9fvoNjeoyZ5Kx0nvr9iwL

--
-- PostgreSQL database dump
--

\restrict vpGw1Q2VgLQGFfG1ygSti9OFtY3Y0jMHG2UZADoCuAPKgw8b8hEJr2U3WLVUhml

-- Dumped from database version 14.22 (Homebrew)
-- Dumped by pg_dump version 14.22 (Homebrew)

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
44	2026_01_31_085404_add_chapter_fields_to_library_table	17
45	2026_02_07_000001_install_temporal_versioning_function	18
46	2026_02_07_000002_add_sys_period_to_nodes	18
47	2026_02_07_000003_create_nodes_history_table	18
48	2026_02_07_000004_create_nodes_versioning_trigger	18
49	2026_02_13_000001_add_source_id_to_bibliography	19
50	2026_02_18_000001_update_library_search_vector_add_booktitle_chapter_editor	20
51	2026_02_18_000002_add_openalex_fields_to_library_table	21
52	2026_02_19_000001_add_preview_nodes_to_hyperlights	22
53	2026_02_19_000002_add_preview_nodes_to_footnotes	22
54	2026_02_23_000001_add_footnote_sub_book_visibility_trigger	23
56	2026_02_26_000001_add_sub_book_id_columns	24
57	2026_03_03_000000_create_password_reset_tokens_table	25
58	2026_03_03_000001_add_password_reset_rls_functions	25
59	2026_03_03_000002_add_session_read_function	25
60	2026_03_03_000003_harden_security_definer_functions	26
61	2026_03_10_000001_add_year_to_library_search_vector	27
62	2026_03_15_000001_fix_sub_book_visibility_trigger_depth	28
63	2026_03_19_000001_create_citation_scans_table	29
64	2026_03_19_000002_add_foundation_source_columns	29
65	2026_03_19_071252_add_open_library_key_to_library_table	30
66	2026_03_19_080000_add_abstract_to_library_table	31
67	2026_03_19_081000_add_pdf_url_status_to_library_table	31
68	2026_03_20_000001_add_status_to_users_table	32
69	2026_03_20_000002_add_status_to_auth_lookup_function	33
70	2026_03_27_000001_add_email_verification_functions	34
71	2026_03_28_000001_add_llm_metadata_to_bibliography	35
72	2026_03_30_000001_create_citation_pipelines_table	36
73	2026_03_30_000002_add_step_timings_to_citation_pipelines	37
74	2026_03_30_100000_add_billing_columns_to_users_table	38
75	2026_03_30_100001_create_billing_ledger_table	38
76	2026_03_31_000001_add_match_metadata_to_bibliography	39
77	2026_03_31_123403_add_match_diagnostics_to_bibliography	40
78	2026_04_03_000001_fix_sub_book_visibility_trigger_fn_pattern	41
79	2026_04_07_000001_create_user_reading_positions_table	41
80	2026_04_09_000001_add_user_id_to_citation_pipelines	42
81	2026_04_10_000001_add_pgvector_embeddings_to_nodes	43
82	2026_04_11_100000_increase_billing_decimal_precision	44
83	2026_04_15_000001_add_access_granted_to_content_tables	45
84	2026_04_16_000001_add_preferences_to_users	46
85	2026_04_16_000002_add_preferences_to_auth_lookup_function	47
86	2026_04_17_000001_create_vibes_table	48
87	2026_04_17_000002_add_pull_count_to_vibes	49
88	2026_04_17_000003_add_source_creator_to_vibes	50
89	2026_04_17_000004_create_pinned_books_table	51
90	2026_04_17_000005_fix_sub_book_visibility_trigger_null_type	52
91	2026_04_18_000005_add_status_to_hypercites_table	53
92	2026_04_18_000006_drop_status_from_hypercites_table	54
93	2026_04_19_000001_add_slug_to_library_table	55
94	2026_04_23_000001_add_book_chunk_id_index_to_nodes	56
95	2026_04_28_000001_add_pipeline_columns_to_footnotes	57
96	2026_04_30_000001_add_gate_defaults_to_library_table	57
97	2026_04_30_000002_add_is_admin_to_users_table	58
\.


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 97, true);


--
-- PostgreSQL database dump complete
--

\unrestrict vpGw1Q2VgLQGFfG1ygSti9OFtY3Y0jMHG2UZADoCuAPKgw8b8hEJr2U3WLVUhml

