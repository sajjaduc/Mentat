/**
 * Code shared between server and browser.
 *
 * Nothing in this module may import `$server` or touch the database: it is
 * bundled into the client. Domain vocabulary that both sides need (status
 * enums, filter AST types, formatting helpers) lives here.
 */
export * from './format';
