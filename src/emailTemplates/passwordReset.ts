export const passwordResetTemplate = `<!doctype html>
<html>
    <body>
        <h1>Password Reset</h1>
        <p>We received a request to reset the password for your davidnet account.</p>
        <a class="verify-button" href="{{resetpassword_url}}">Reset Password</a>
        <div class="SmallSpacer"></div>

        <p>
            If you did not request a password reset, please ignore this email. Your password will remain 
            unchanged.
        </p>

        <br />
        <div class="Spacer"></div>
        <br />

        <span id="legal">
            <a href="https://davidnet.net/legal/terms_of_service/">Terms of Service</a>
            |
            <a href="https://davidnet.net/legal/privacy_policy/">Privacy Policy</a>
            |
            <a href="https://davidnet.net/legal/">More</a>
        </span>
        <br />
        <div class="Spacer"></div>
        <br />
        <span>
            For any questions, visit our help center
            <a href="https://davidnet.net/help">help center</a>
            .
        </span>
        <br />

        <br />
        <span><strong>Do not reply to this email.</strong></span>
    </body>
</html>

<style>
    body {
        display: flex;
        justify-content: center;
        align-items: center;
        text-align: center;
        flex-direction: column;

        background-color: #ffffff;
        color: #111111;
        font-family:
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            Roboto,
            Oxygen,
            Ubuntu,
            Cantarell,
            "Open Sans",
            "Helvetica Neue",
            sans-serif;
        padding: 30px 20px;
        line-height: 1.5;
    }

    a.verify-button {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        min-width: 120px;
        height: 2rem;
        padding: 0.5rem 1rem;
        gap: 0.5rem;
        box-sizing: border-box;
        white-space: nowrap;
        vertical-align: middle;
        position: relative;
        margin-right: 0.25rem;

        font-size: 1rem;
        line-height: 1;
        text-align: center;
        text-decoration: none;

        border: none;
        border-radius: 0.2rem;
        cursor: pointer;

        transition:
            background-color 200ms ease,
            color 200ms ease;
    }

    a.verify-button:hover {
        background-color: #1669c1;
    }

    h3 {
        margin: 0px;
    }

    #legal {
        font-size: 0.8rem;
    }

    @media (prefers-color-scheme: dark) {
        body {
            background-color: #1d2125;
            color: #f1f1f1;
        }

        a.verify-button {
            background-color: #0d3e8b;
            color: #f1f1f1;
        }

        a.verify-button:hover {
            background-color: #145fcc;
        }
    }

    .Spacer {
        height: 2rem;
    }

    .SmallSpacer {
        height: 1rem;
    }

    p {
        max-width: 460px;
        margin: 10px 0;
    }

    a {
        color: #1a73e8;
    }

    @media (prefers-color-scheme: dark) {
        a {
            color: #8ab4f8;
        }
    }
</style>`;
