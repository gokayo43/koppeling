/** The two fixture programs as the door offers them, for the suite and for `bin/walk.ts`. */
import { fromElysia, fromTrpcRouter } from "../../src/index";
import { toDirectory, type Directory } from "../../src/tools";
import { apiApp, credential, type ApiActor } from "./api";
import { contextFor, warehouseRouter, type WarehouseActor } from "./warehouse";

export const warehouseAdmin: WarehouseActor = { id: 1, name: "Beheerder", role: "admin" };
export const warehousePicker: WarehouseActor = { id: 2, name: "Picker", role: "picker" };
export const apiCaller: ApiActor = { key: "fixture-key" };

export function warehouseDirectory(invoked?: (path: string) => void): Directory<WarehouseActor> {
  return toDirectory(fromTrpcRouter(warehouseRouter(invoked), { contextFor }));
}

export function apiDirectory(invoked?: (route: string) => void): Directory<ApiActor> {
  return toDirectory(fromElysia(apiApp(invoked), { credential, mount: "/api/v1" }));
}
