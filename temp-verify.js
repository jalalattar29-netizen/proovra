const crypto = require('crypto');
const secret = 'HdNdx87WbuZn0fO6LaOjOxquact5iG3613LoVxiYiaw=';
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJiZDgxMDRhOC00OWRiLTRjMDAtOWFiNS01ZTgzZTk3MDIzMTYiLCJwcm92aWRlciI6IkdVRVNUIiwiZW1haWwiOm51bGwsImlhdCI6MTc4MDc5ODI3OSwiZXhwIjoxNzgzMzkwMjc5LCJzaWQiOiJkNmJlNGIzYjM5OWZmOTI3YzVkZjIzNzQ0MWRjODFkMyJ9.hE-drwRtLZd217dxzmLMZvhPe27MFJ9UAeOy3o0aHEc';
const [headerB64, payloadB64, signatureB64] = token.split('.');
const signingInput = `${headerB64}.${payloadB64}`;
const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
const actual = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
console.log('verify', expected.length === actual.length && crypto.timingSafeEqual(expected, actual));
console.log('payload', JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()));
