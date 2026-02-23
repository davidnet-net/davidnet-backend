import app from ".."

export async function registerRoutes() {
    app.get('/', (c) => {
        return c.text('Hello Hono!')
    })
}