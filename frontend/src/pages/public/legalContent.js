// DRAFT legal text for SHARKPOS. It has NOT been reviewed by a lawyer and is NOT legally approved.
// Square-bracket items are placeholders the business owner must fill in. Have a qualified Indian lawyer review before launch.
import { site } from '../../siteConfig.js';

const S = (heading, ...paras) => ({ heading, paras });

export const LEGAL = {
  terms: {
    title: 'Terms of Service',
    summary: 'The rules for using SHARKPOS.',
    sections: [
      S('1. About these terms', `These terms apply when you use SHARKPOS, a cloud service for billing, stock and shop management operated by ${site.legalEntity} ("we", "us"). By creating an account or using the service you agree to them. If you use it for a business, you confirm you can bind that business.`),
      S('2. Your account', 'You must give correct details and keep your password private. You are responsible for what happens under your account, including actions by staff you add. Tell us quickly if you think someone else has access.'),
      S('3. Free trial and plans', 'New businesses get a free trial (currently 14 days). After the trial, continued use of billing and data-changing features needs a paid plan. Plan names, prices and limits are shown on our pricing page and may change; a price change applies from your next renewal, not to a period you have already paid for.'),
      S('4. Payments', 'Plan payments are processed online by Razorpay. We do not see or store your card, UPI or bank details. Your plan is switched on only after our server has confirmed the payment with Razorpay.'),
      S('5. If your plan ends', 'If your trial or plan ends, your data is kept and you can still view it. You cannot create new bills or change records until you renew. We may delete data of accounts that have been inactive for a long time after giving you notice at your registered email. [Retention period — to be decided.]'),
      S('6. Your data', 'Your shop data (products, sales, customers, staff) belongs to you. We process it only to run the service for you, as described in our Privacy Policy. You are responsible for the accuracy of your records and for the invoices and tax returns you issue.'),
      S('7. Acceptable use', 'Do not use the service for anything unlawful, to attack or overload it, to try to reach another business\'s data, or to resell it without our written permission.'),
      S('8. AI features', 'Some features use automated analysis and, if switched on, an AI model to answer questions about your own data. Their output can be wrong or incomplete and is not financial, tax or legal advice. Please check important figures yourself.'),
      S('9. Availability', 'We work to keep the service running but do not promise it will be uninterrupted or error-free. We may pause it for maintenance. Keep your own copy of anything critical, such as printed invoices.'),
      S('10. Our responsibility', 'To the extent the law allows, we are not liable for indirect or consequential losses such as lost profit or lost sales, and our total liability for any claim is limited to the amount you paid us in the three months before the claim. Nothing here limits liability that cannot be limited by law. [Lawyer to confirm.]'),
      S('11. Ending the agreement', 'You can stop using SHARKPOS at any time. We may suspend or close an account that breaks these terms or puts others at risk, and will tell you why where we can.'),
      S('12. Changes', 'We may update these terms. For material changes we will give notice in the app or by email before they apply.'),
      S('13. Governing law', `These terms are governed by the laws of India. Courts at [city — to be added] have jurisdiction, subject to any rights you have under consumer protection law.`),
      S('14. Contact', `${site.legalEntity}, ${site.address}.${site.supportEmail ? ` Email: ${site.supportEmail}.` : ' [Support email — to be added.]'}`),
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    summary: 'What data we collect, why, and who we share it with.',
    sections: [
      S('1. Who we are', `${site.legalEntity} operates SHARKPOS. For the personal data in your account, we decide how it is used ("data fiduciary" under India's Digital Personal Data Protection Act, 2023). For your customers' details that you enter, you decide the purpose and we process it on your behalf.`),
      S('2. What we collect', 'Account data: name, email, phone (optional), a password stored only as a one-way hash. Business data: shop name and address, GSTIN if you add it, products, stock, sales, customers and staff you enter. Technical data: IP address, browser type, sign-in times, and security and audit logs.'),
      S('3. Why we use it', 'To provide the service, keep it secure, prevent fraud and abuse, take plan payments, send service messages, fix problems, and meet legal duties. We do not sell your data and do not use it for third-party advertising.'),
      S('4. Who we share it with', 'Service providers who run parts of SHARKPOS for us: web and application hosting (Cloudflare, Render), database hosting (Neon), code and backup storage (GitHub) and payments (Razorpay). [Final provider list and regions — to be confirmed before launch.] If AI features are switched on, the question and the shop figures needed to answer it are sent to the AI provider we use. We also share data where the law requires it.'),
      S('5. Your customers\' data', 'If you store your own customers\' names or phone numbers, you should tell them and use the data only for your shop. Please do not enter more than you need.'),
      S('6. How long we keep it', 'While your account exists. After it ends we keep it for [period — to be decided], then delete it, except for records we must keep by law (for example payment and tax records). Encrypted backups are removed on a rolling schedule.'),
      S('7. Security', 'Each business\'s data is separated in our database by technical controls, passwords are hashed, sign-in sessions expire, connections use HTTPS, and backups are encrypted. No system is perfectly secure; if there is a breach that affects you we will tell you as the law requires.'),
      S('8. Your rights', `You can ask to see, correct, download or delete your personal data, and to withdraw consent. ${site.supportEmail ? `Write to ${site.supportEmail}.` : 'Write to our support email [to be added].'} We will answer within a reasonable time and in line with applicable law.`),
      S('9. Cookies', 'We use one strictly necessary cookie to keep you signed in. We do not use advertising or tracking cookies. [Update this if analytics is added.]'),
      S('10. Children', 'SHARKPOS is for businesses and is not meant for people under 18.'),
      S('11. Grievances', `Grievance officer: ${site.grievanceOfficer}${site.supportEmail ? `, ${site.supportEmail}` : ' [email — to be added]'}. We aim to acknowledge complaints promptly and resolve them within the time the law sets.`),
      S('12. Changes', `We may update this policy and will show the date of the latest version (${site.lastUpdated}) and tell you about material changes.`),
    ],
  },
  refunds: {
    title: 'Refunds & Cancellation Policy',
    summary: 'How cancelling and refunds work for paid plans.',
    sections: [
      S('1. Free trial', 'The trial is free and needs no payment details. If you do nothing, it simply ends and nothing is charged.'),
      S('2. Cancelling', 'You can cancel your plan from the Billing page. Your plan stays active until the end of the period you have paid for, then stops. We do not charge you again.'),
      S('3. Refunds', '[Refund rule — to be decided by the business owner. Example wording: "If you are charged by mistake, or you ask within 7 days of your first payment and have not used the service heavily, we will refund that payment in full."] Refunds, where given, go back to the original payment method.'),
      S('4. Timing', 'After a refund is approved, Razorpay and your bank usually take [5–7 business days — confirm with Razorpay] to show it in your account.'),
      S('5. Plan changes', 'Upgrades start immediately. A downgrade starts at your next renewal. [Whether the unused part of a period is credited — to be decided.]'),
      S('6. Failed or duplicate payments', 'If money was taken but your plan did not start, write to us with the payment reference. We will check with Razorpay and either activate your plan or refund you.'),
      S('7. How to ask', `${site.supportEmail ? `Email ${site.supportEmail}` : 'Email our support address [to be added]'} from your registered email with your business name and payment reference.`),
    ],
  },
};
