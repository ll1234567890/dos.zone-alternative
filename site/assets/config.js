// Site configuration.
//
// RELAY_URL: the DOS Harbor multiplayer relay (server/ in this repo), e.g.
//   "wss://dosharbor-relay.onrender.com"
// Leave empty to fall back to the public js-dos peer server (net.dos.zone).
// A `?server=wss://…` URL parameter overrides this for testing; invite links
// carry it along so everyone in a room uses the same server.
export const RELAY_URL = "wss://dosharbor-relay.onrender.com";
