// Auth module.
#include <string>
#include "util/crypto.hpp"

namespace app {

/// Token time-to-live, in seconds.
const int TOKEN_TTL = 900;

/// Hashing algorithm.
enum class Algo { Sha256, Blake3 };

/// A minted credential.
using Token = std::string;

/// A thing that can check credentials.
class Validator {
public:
    virtual bool validate(const std::string &pw) = 0;
};

/// Auth business logic.
class AuthService : public Validator {
public:
    /// Validate a set of login credentials.
    bool validate(const std::string &pw) override {
        return !hash_token(pw).empty();
    }

    std::string issue(const std::string &pw);
};

std::string AuthService::issue(const std::string &pw) {
    return validate(pw) ? hash_token(pw) : "";
}

/// A key/value pair carried alongside a token.
struct Claim {
    std::string key;
};

/// Construct a fresh service.
AuthService *bootstrap() {
    return new AuthService();
}

}  // namespace app
