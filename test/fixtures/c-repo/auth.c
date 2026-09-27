/* Auth module. */
#include <stdlib.h>
#include "util/crypto.h"

/* Token time-to-live, in seconds. */
#define TOKEN_TTL 900

/* A minted credential. */
typedef char *Token;

/* Hashing algorithm. */
enum Algo {
    ALGO_SHA256,
    ALGO_BLAKE3,
};

/* Auth business logic. */
struct AuthService {
    int seen;
};

/* Validate a set of login credentials. */
int auth_validate(struct AuthService *svc, const char *pw) {
    return hash_token(pw) != NULL;
}

/* Issue a token for valid credentials. */
Token auth_issue(struct AuthService *svc, const char *pw) {
    if (auth_validate(svc, pw)) {
        return hash_token(pw);
    }
    return NULL;
}
