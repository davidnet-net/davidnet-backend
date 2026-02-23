import { Hono } from "hono"
import { health } from "./health"

export async function registerRoutes(app: Hono) {
    app.route('/health', health)
}