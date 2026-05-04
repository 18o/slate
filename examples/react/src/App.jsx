import { useState } from 'react';

export default function App({ url }) {
  const [count, setCount] = useState(0);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>React + Slate SSR</title>
      </head>
      <body>
        <h1>React + Slate SSR</h1>
        <p>Current URL: {url}</p>
        <p>Count: {count}</p>
        <button onClick={() => setCount(c => c + 1)}>+1</button>
        <p>
          Try <a href="/api/hello">/api/hello</a> or <a href="/api/time">/api/time</a>
        </p>
      </body>
    </html>
  );
}
