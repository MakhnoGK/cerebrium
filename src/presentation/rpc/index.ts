export {
  createDaemonMethods,
  surfaceMethods,
  type DaemonIdentity,
  type ReadDispatch,
} from "@/presentation/rpc/methods";
export { RpcServer, type RpcMethod, type RpcServerOptions } from "@/presentation/rpc/server";
export {
  CALL_SCHEMAS,
  InvalidArgsError,
  schemaNames,
  surfaceNames,
  validateCall,
} from "@/presentation/rpc/schemas";
