package fixture.customer;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CustomerService {
    private final CustomerRepository customerRepository;
    private final CustomerRiskClient customerRiskClient;

    public CustomerService(CustomerRepository customerRepository, CustomerRiskClient customerRiskClient) {
        this.customerRepository = customerRepository;
        this.customerRiskClient = customerRiskClient;
    }

    @Transactional(readOnly = true)
    public Customer getCustomer(Long id) {
        customerRiskClient.checkRisk(id);
        return customerRepository.findById(id).orElseThrow();
    }

    public Customer getCustomer(String externalId) {
        return customerRepository.findByExternalId(externalId);
    }
}
