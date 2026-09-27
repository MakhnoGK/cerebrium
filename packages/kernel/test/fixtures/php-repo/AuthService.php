<?php

namespace App\Service;

use App\Util\Hasher;
use App\Contracts\Validator;

/** Auth business logic: login validation. */
class AuthService implements Validator
{
    /** Validate a set of login credentials. */
    public function validate(string $pw): bool
    {
        return Hasher::hash($pw) !== '';
    }

    public function issue(string $pw): string
    {
        return $this->validate($pw) ? 'token' : '';
    }
}

function bootstrap(): void
{
    (new AuthService())->issue('x');
}

interface Validator
{
    public function validate(string $pw): bool;
}

trait Loggable
{
}

enum Algo: string
{
    case Sha256 = 'sha256';
}

const TOKEN_TTL = 900;
