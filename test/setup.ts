import "reflect-metadata";
import { container } from "tsyringe";
import { DB_TOKEN } from "../src/db/repositories/base";
import { openDatabase } from "../src/db/database";

container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
