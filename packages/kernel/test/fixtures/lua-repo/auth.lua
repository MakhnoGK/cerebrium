-- Auth module.
local crypto = require("util.crypto")

--- Token time-to-live, in seconds.
local TOKEN_TTL = 900

--- Auth business logic.
local AuthService = {}

--- Validate a set of login credentials.
function AuthService.validate(pw)
  return crypto.hash_token(pw) ~= ""
end

--- Issue a token for valid credentials.
function AuthService:issue(pw)
  if AuthService.validate(pw) then
    return crypto.hash_token(pw)
  end
  return ""
end

--- Construct a fresh service.
local function bootstrap()
  return setmetatable({}, { __index = AuthService })
end

--- Reset the module-level counter.
function reset_counter()
  TOKEN_TTL = 900
end

return AuthService
