// Importing this module is what registers the local implementations against the tokens in
// `contracts`. A host imports it once; nothing imports the classes by name.
import "@/application/use-cases/local/consolidation";
import "@/application/use-cases/local/fetch-nodes";
import "@/application/use-cases/local/invalidate-memory";
import "@/application/use-cases/local/link-nodes";
import "@/application/use-cases/local/lookup-code";
import "@/application/use-cases/local/mirrors";
import "@/application/use-cases/local/operations";
import "@/application/use-cases/local/record-checkpoint";
import "@/application/use-cases/local/restore-memory";
import "@/application/use-cases/local/search-memory";
import "@/application/use-cases/local/session";
import "@/application/use-cases/local/update-memory";
import "@/application/use-cases/local/write-memory";
